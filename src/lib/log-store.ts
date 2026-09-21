import { Redis as UpstashRedis } from "@upstash/redis";
import IORedis, { type RedisOptions } from "ioredis";
import type {
  ApiDebugLog,
  ApiDebugLogPayload,
  ApiDebugLogSummary,
  ApiDebugMethodFilter,
  ApiDebugStatusFilter,
  ApiDebugStorageMode,
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

/** A self-hosted Redis speaks RESP over a socket, so an unreachable server has
 *  to fail fast rather than park the dashboard request on ioredis' default
 *  20-attempt retry ladder. */
const REDIS_CONNECT_TIMEOUT_MS = 5000;
const REDIS_MAX_RETRIES_PER_REQUEST = 2;

/** How long the store keeps serving from memory after Redis proves unreachable,
 *  before it is worth paying the connection cost to try again. */
const REDIS_RETRY_COOLDOWN_MS = 30_000;

/** The slice of Redis this store actually uses. Keeping it behind one type is
 *  what lets the self-hosted (RESP) and Upstash (REST) backends stay
 *  interchangeable for everything below. */
type LogRedisClient = {
  lpush(key: string, log: ApiDebugLog): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  trimAndExpire(key: string, stop: number, seconds: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<ApiDebugLog[]>;
  del(key: string): Promise<unknown>;
};

type SelfHostedConfig = { kind: "self-hosted"; url?: string; options: RedisOptions };
type UpstashConfig = { kind: "upstash"; url: string; token: string };
type RedisConfig = SelfHostedConfig | UpstashConfig;

type GlobalLogStore = typeof globalThis & {
  __erpApiDebugCenterLogs?: Map<string, ApiDebugLog[]>;
  __erpApiDebugCenterRedis?: LogRedisClient;
  __erpApiDebugCenterRedisDownUntil?: number;
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

/** Reads an env var, treating a blank value as unset. `REDIS_PASSWORD=` on an
 *  auth-less server has to mean "no password", not "authenticate as empty". */
function readEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getSelfHostedConfig(): SelfHostedConfig | null {
  const url = readEnv("REDIS_URL");
  const host = readEnv("REDIS_HOST");

  if (!url && !host) return null;

  const options: RedisOptions = {
    // Connect on the first command rather than at import time, so a build or a
    // cold start does not depend on Redis already being up.
    lazyConnect: true,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
  };

  const username = readEnv("REDIS_USERNAME");
  const password = readEnv("REDIS_PASSWORD");
  const db = Number(readEnv("REDIS_DB"));

  if (username) options.username = username;
  if (password) options.password = password;
  if (Number.isInteger(db) && db >= 0) options.db = db;

  // A URL already carries host/port/auth, so the discrete vars only apply
  // when no URL was given.
  if (url) return { kind: "self-hosted", url, options };

  return {
    kind: "self-hosted",
    options: { ...options, host, port: Number(readEnv("REDIS_PORT")) || 6379 },
  };
}

function getUpstashConfig(): UpstashConfig | null {
  const url = readEnv("KV_REST_API_URL") ?? readEnv("UPSTASH_REDIS_REST_URL");
  const token = readEnv("KV_REST_API_TOKEN") ?? readEnv("UPSTASH_REDIS_REST_TOKEN");

  if (!url || !token) return null;

  return { kind: "upstash", url, token };
}

/** A self-hosted server wins when both are configured: it is the one with no
 *  per-command quota, so leftover Upstash vars never silently take over. */
function getRedisConfig(): RedisConfig | null {
  return getSelfHostedConfig() ?? getUpstashConfig();
}

/** ioredis stores and returns opaque strings, so logs are serialised here.
 *  An entry that will not parse is dropped rather than allowed to fail the
 *  whole dashboard fetch. */
function parseLogs(entries: string[]): ApiDebugLog[] {
  const logs: ApiDebugLog[] = [];

  for (const entry of entries) {
    try {
      logs.push(JSON.parse(entry) as ApiDebugLog);
    } catch {
      continue;
    }
  }

  return logs;
}

function createSelfHostedClient(config: SelfHostedConfig): LogRedisClient {
  const redis = config.url ? new IORedis(config.url, config.options) : new IORedis(config.options);

  // ioredis emits 'error' on every failed connection attempt. With no listener
  // attached, Node treats that as an unhandled 'error' event and exits.
  let lastError: string | null = null;

  redis.on("error", (error: Error) => {
    // Reconnection is retried forever in the background, so report each
    // distinct failure once rather than once every couple of seconds.
    if (error.message === lastError) return;

    lastError = error.message;
    console.error("[log-store] redis connection error:", error.message);
  });

  redis.on("ready", () => {
    lastError = null;
  });

  return {
    lpush: (key, log) => redis.lpush(key, JSON.stringify(log)),
    expire: (key, seconds) => redis.expire(key, seconds),
    trimAndExpire: (key, stop, seconds) =>
      redis.pipeline().ltrim(key, 0, stop).expire(key, seconds).exec(),
    lrange: async (key, start, stop) => parseLogs(await redis.lrange(key, start, stop)),
    del: (key) => redis.del(key),
  };
}

function createUpstashClient(config: UpstashConfig): LogRedisClient {
  const redis = new UpstashRedis({ url: config.url, token: config.token });

  return {
    lpush: (key, log) => redis.lpush(key, log),
    expire: (key, seconds) => redis.expire(key, seconds),
    trimAndExpire: (key, stop, seconds) =>
      redis.pipeline().ltrim(key, 0, stop).expire(key, seconds).exec(),
    lrange: (key, start, stop) => redis.lrange<ApiDebugLog>(key, start, stop),
    del: (key) => redis.del(key),
  };
}

/** True while a connection failure has Redis benched. Running the dashboard
 *  against a machine with no Redis — the ordinary local setup — should not need
 *  an env change, so the store degrades to memory rather than failing requests. */
function isRedisDegraded() {
  const store = globalThis as GlobalLogStore;
  return (store.__erpApiDebugCenterRedisDownUntil ?? 0) > Date.now();
}

function benchRedis(error: ApiDebugStorageError) {
  const store = globalThis as GlobalLogStore;
  store.__erpApiDebugCenterRedisDownUntil = Date.now() + REDIS_RETRY_COOLDOWN_MS;

  // Reachable at most once per cooldown — isRedisDegraded() short-circuits
  // every request in between — so this cannot flood the log.
  console.warn(`[log-store] ${error.message} — serving logs from memory for now`);
}

function unbenchRedis() {
  const store = globalThis as GlobalLogStore;
  if (!store.__erpApiDebugCenterRedisDownUntil) return;

  store.__erpApiDebugCenterRedisDownUntil = 0;
  console.info("[log-store] redis is reachable again — resuming shared storage");
}

function getRedis(): LogRedisClient | null {
  const config = getRedisConfig();
  if (!config || isRedisDegraded()) return null;

  const store = globalThis as GlobalLogStore;
  store.__erpApiDebugCenterRedis ??=
    config.kind === "self-hosted" ? createSelfHostedClient(config) : createUpstashClient(config);

  return store.__erpApiDebugCenterRedis;
}

export function getApiDebugStorageMode(): ApiDebugStorageMode {
  if (!getRedisConfig()) return "memory";
  return isRedisDegraded() ? "memory-fallback" : "redis";
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

/** A managed plan answers HTTP 429 once its monthly command or bandwidth budget
 *  is spent. Written narrowly so it does not also swallow ioredis' "Reached the
 *  max retries per request limit", which means a dead connection, not a quota. */
const QUOTA_PATTERN =
  /\b429\b|too many requests|quota|max\s+\w*\s*(?:requests?|commands?|bandwidth)\s+limit/i;

/** A socket-level failure: Redis is down, or the host/port is wrong. */
const UNREACHABLE_PATTERN =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|EPIPE|connection is closed|max retries per request/i;

/** Storage failures reach the route as opaque throws, so label the two that
 *  have a specific fix: an exhausted managed quota, and an unreachable server. */
export class ApiDebugStorageError extends Error {
  readonly quotaExceeded: boolean;
  readonly unreachable: boolean;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const quotaExceeded = QUOTA_PATTERN.test(detail);
    const unreachable = !quotaExceeded && UNREACHABLE_PATTERN.test(detail);

    super(
      quotaExceeded
        ? `Redis rejected the request — the managed plan's command or bandwidth quota looks exhausted (${detail})`
        : unreachable
          ? `Redis is unreachable — check the server is running and REDIS_URL / REDIS_HOST point at it (${detail})`
          : `Redis request failed (${detail})`
    );

    this.name = "ApiDebugStorageError";
    this.quotaExceeded = quotaExceeded;
    this.unreachable = unreachable;
    this.cause = cause;
  }
}

/** Runs a Redis operation, quietly falling back to the in-memory store when the
 *  server is unreachable — that is just "no Redis on this machine", which the
 *  dashboard can serve on its own. Every other failure (bad auth, OOM, an
 *  exhausted managed quota) still throws: those need fixing, not papering over. */
async function withRedis<T>(
  run: (redis: LogRedisClient) => Promise<T>,
  fallback: () => T
): Promise<T> {
  const redis = getRedis();
  if (!redis) return fallback();

  try {
    const result = await run(redis);
    unbenchRedis();

    return result;
  } catch (cause) {
    const error = new ApiDebugStorageError(cause);
    if (!error.unreachable) throw error;

    benchRedis(error);
    return fallback();
  }
}

export async function addApiDebugLog(payload: Partial<ApiDebugLogPayload>, sessionId: string) {
  const log: ApiDebugLog = {
    id: crypto.randomUUID(),
    ...coerceLogPayload(payload),
  };
  const key = sessionKey(sessionId);

  return withRedis(
    async (redis) => {
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
        await redis.trimAndExpire(key, getMaxLogs() - 1, SESSION_TTL_SECONDS);
      }

      return log;
    },
    () => {
      const logs = getSessionLogs(sessionId);
      logs.unshift(log);
      logs.splice(getMaxLogs());

      return log;
    }
  );
}

export async function getApiDebugLogs(
  sessionId: string,
  filter: ApiDebugStatusFilter = "all",
  detailId: string | null = null,
  method: ApiDebugMethodFilter = "all"
): Promise<ApiDebugLogSummary[]> {
  const key = sessionKey(sessionId);

  const logs = await withRedis(
    (redis) => redis.lrange(key, 0, getMaxLogs() - 1),
    () => getSessionLogs(sessionId)
  );

  return projectLogs(filterLogsByMethod(filterLogs(logs, filter), method), detailId);
}

export async function clearApiDebugLogs(sessionId: string) {
  const key = sessionKey(sessionId);

  await withRedis(
    (redis) => redis.del(key),
    () => getStore().delete(sessionId)
  );
}
