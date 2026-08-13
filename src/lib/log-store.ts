import { Redis } from "@upstash/redis";
import type {
  ApiDebugLog,
  ApiDebugLogPayload,
  ApiDebugLogSummary,
  ApiDebugMethodFilter,
  ApiDebugStatusFilter,
} from "./types";

const DEFAULT_MAX_LOGS = 300;
const LOG_KEY = process.env.DEBUG_CENTER_REDIS_KEY || "erp-api-debug-center:logs";

/** 24 hours — idle session keys are cleaned up automatically */
const SESSION_TTL_SECONDS = 60 * 60 * 24;

/** How far the list is allowed to overshoot maxLogs before it gets trimmed.
 *  Trimming and refreshing the TTL on *every* write tripled the command count
 *  (419K of the 582K commands that burned the free-tier quota were writes).
 *  Letting the list overshoot amortises those two commands across this many
 *  writes, taking the steady-state cost from 3 commands per log to ~1.04.
 *  Reads use LRANGE 0..maxLogs-1, so the overshoot is never visible. */
const TRIM_SLACK = 50;

type GlobalLogStore = typeof globalThis & {
  __erpApiDebugCenterLogs?: Map<string, ApiDebugLog[]>;
  __erpApiDebugCenterRedis?: Redis;
};

function getMaxLogs() {
  const parsed = Number(process.env.DEBUG_CENTER_MAX_LOGS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LOGS;
}

/** Returns the per-session Redis key. */
function sessionKey(sessionId: string) {
  return `${LOG_KEY}:${sessionId}`;
}

/** In-memory fallback: one Map shared across the process, keyed by sessionId. */
function getStore(): Map<string, ApiDebugLog[]> {
  const store = globalThis as GlobalLogStore;
  store.__erpApiDebugCenterLogs ??= new Map<string, ApiDebugLog[]>();
  return store.__erpApiDebugCenterLogs;
}

function getSessionLogs(sessionId: string): ApiDebugLog[] {
  const store = getStore();
  if (!store.has(sessionId)) store.set(sessionId, []);
  return store.get(sessionId)!;
}

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) return null;

  return { url, token };
}

function getRedis() {
  const config = getRedisConfig();
  if (!config) return null;

  const store = globalThis as GlobalLogStore;
  store.__erpApiDebugCenterRedis ??= new Redis(config);

  return store.__erpApiDebugCenterRedis;
}

export function getApiDebugStorageMode() {
  return getRedisConfig() ? "redis" : "memory";
}

function coerceLogPayload(payload: Partial<ApiDebugLogPayload>): ApiDebugLogPayload {
  return {
    timestamp: typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString(),
    source: typeof payload.source === "string" ? payload.source : "unknown",
    environment: typeof payload.environment === "string" ? payload.environment : "unknown",
    method: typeof payload.method === "string" ? payload.method.toUpperCase() : "GET",
    endpoint: typeof payload.endpoint === "string" ? payload.endpoint : "/unknown",
    status: typeof payload.status === "number" ? payload.status : null,
    durationMs: typeof payload.durationMs === "number" ? Math.max(0, payload.durationMs) : 0,
    success: Boolean(payload.success),
    requestBody: payload.requestBody ?? null,
    responseBody: payload.responseBody ?? null,
    errorMessage: typeof payload.errorMessage === "string" ? payload.errorMessage : null,
  };
}

function filterLogs(logs: ApiDebugLog[], filter: ApiDebugStatusFilter) {
  if (filter === "success") return logs.filter((log) => log.success);
  if (filter === "failed") return logs.filter((log) => !log.success);

  return logs;
}

function filterLogsByMethod(logs: ApiDebugLog[], method: ApiDebugMethodFilter) {
  if (method === "all") return logs;
  return logs.filter((log) => log.method === method);
}

/** Drops request/response bodies. These dominate the payload size, and the
 *  dashboard only ever renders the bodies of the single selected log. */
function toSummary(log: ApiDebugLog): ApiDebugLogSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured to drop the bodies
  const { requestBody, responseBody, ...rest } = log;
  return { ...rest, truncated: true };
}

/** Keeps full bodies for `detailId` only; everything else is summarised.
 *  With no `detailId`, the newest log keeps its bodies because that is what
 *  the dashboard auto-selects on first paint. */
function projectLogs(logs: ApiDebugLog[], detailId: string | null): ApiDebugLogSummary[] {
  const expandedId = detailId ?? logs[0]?.id ?? null;
  return logs.map((log) => (log.id === expandedId ? log : toSummary(log)));
}

/** Upstash returns HTTP 429 once the plan's monthly command or bandwidth
 *  budget is spent. That surfaces here as an opaque throw, so label it. */
export class ApiDebugStorageError extends Error {
  readonly quotaExceeded: boolean;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const quotaExceeded = /429|too many requests|quota|exceeded|limit/i.test(detail);

    super(
      quotaExceeded
        ? `Redis rejected the request — the Upstash plan's command or bandwidth quota looks exhausted (${detail})`
        : `Redis request failed (${detail})`
    );

    this.name = "ApiDebugStorageError";
    this.quotaExceeded = quotaExceeded;
    this.cause = cause;
  }
}

export async function addApiDebugLog(payload: Partial<ApiDebugLogPayload>, sessionId: string) {
  const log: ApiDebugLog = {
    id: crypto.randomUUID(),
    ...coerceLogPayload(payload),
  };
  const redis = getRedis();
  const key = sessionKey(sessionId);

  if (redis) {
    try {
      // LPUSH returns the new length, which tells us whether any follow-up
      // maintenance is due without spending a command to ask.
      const length = await redis.lpush(key, log);

      if (length === 1) {
        // Fresh key — it must get a TTL now, or it would leak forever.
        await redis.expire(key, SESSION_TTL_SECONDS);
      } else if (length % TRIM_SLACK === 0 || length >= getMaxLogs() + TRIM_SLACK) {
        // Amortised maintenance: cap the list and push the expiry back out.
        // Keyed off every TRIM_SLACK-th write rather than only on overflow, so
        // a low-traffic session still refreshes its TTL and never expires
        // mid-use. LTRIM below the cap is a harmless no-op.
        await redis
          .pipeline()
          .ltrim(key, 0, getMaxLogs() - 1)
          .expire(key, SESSION_TTL_SECONDS)
          .exec();
      }
    } catch (error) {
      throw new ApiDebugStorageError(error);
    }

    return log;
  }

  const logs = getSessionLogs(sessionId);
  logs.unshift(log);
  logs.splice(getMaxLogs());

  return log;
}

export async function getApiDebugLogs(
  sessionId: string,
  filter: ApiDebugStatusFilter = "all",
  detailId: string | null = null,
  method: ApiDebugMethodFilter = "all"
): Promise<ApiDebugLogSummary[]> {
  const redis = getRedis();
  const key = sessionKey(sessionId);

  if (redis) {
    let logs: ApiDebugLog[];

    try {
      logs = await redis.lrange<ApiDebugLog>(key, 0, getMaxLogs() - 1);
    } catch (error) {
      throw new ApiDebugStorageError(error);
    }

    return projectLogs(filterLogsByMethod(filterLogs(logs, filter), method), detailId);
  }

  return projectLogs(
    filterLogsByMethod(filterLogs(getSessionLogs(sessionId), filter), method),
    detailId
  );
}

export async function clearApiDebugLogs(sessionId: string) {
  const redis = getRedis();
  const key = sessionKey(sessionId);

  if (redis) {
    try {
      await redis.del(key);
    } catch (error) {
      throw new ApiDebugStorageError(error);
    }

    return;
  }

  getStore().delete(sessionId);
}
