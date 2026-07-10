import { Redis } from "@upstash/redis";
import type { ApiDebugLog, ApiDebugLogPayload, ApiDebugStatusFilter } from "./types";

const DEFAULT_MAX_LOGS = 300;
const LOG_KEY = process.env.DEBUG_CENTER_REDIS_KEY || "erp-api-debug-center:logs";

/** 24 hours — idle session keys are cleaned up automatically */
const SESSION_TTL_SECONDS = 60 * 60 * 24;

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

export async function addApiDebugLog(
  payload: Partial<ApiDebugLogPayload>,
  sessionId: string,
) {
  const log: ApiDebugLog = {
    id: crypto.randomUUID(),
    ...coerceLogPayload(payload),
  };
  const redis = getRedis();
  const key = sessionKey(sessionId);

  if (redis) {
    await redis.lpush(key, log);
    await redis.ltrim(key, 0, getMaxLogs() - 1);
    // Refresh TTL on every write so active sessions never expire mid-use
    await redis.expire(key, SESSION_TTL_SECONDS);

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
) {
  const redis = getRedis();
  const key = sessionKey(sessionId);

  if (redis) {
    const logs = await redis.lrange<ApiDebugLog>(key, 0, getMaxLogs() - 1);
    return filterLogs(logs, filter);
  }

  return filterLogs(getSessionLogs(sessionId), filter);
}

export async function clearApiDebugLogs(sessionId: string) {
  const redis = getRedis();
  const key = sessionKey(sessionId);

  if (redis) {
    await redis.del(key);
    return;
  }

  getStore().delete(sessionId);
}
