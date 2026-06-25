import { Redis } from "@upstash/redis";
import type { ApiDebugLog, ApiDebugLogPayload, ApiDebugStatusFilter } from "./types";

const DEFAULT_MAX_LOGS = 300;
const LOG_KEY = process.env.DEBUG_CENTER_REDIS_KEY || "erp-api-debug-center:logs";

type GlobalLogStore = typeof globalThis & {
  __erpApiDebugCenterLogs?: ApiDebugLog[];
  __erpApiDebugCenterRedis?: Redis;
};

function getMaxLogs() {
  const parsed = Number(process.env.DEBUG_CENTER_MAX_LOGS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LOGS;
}

function getStore() {
  const store = globalThis as GlobalLogStore;
  store.__erpApiDebugCenterLogs ??= [];
  return store.__erpApiDebugCenterLogs;
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

export async function addApiDebugLog(payload: Partial<ApiDebugLogPayload>) {
  const log: ApiDebugLog = {
    id: crypto.randomUUID(),
    ...coerceLogPayload(payload),
  };
  const redis = getRedis();

  if (redis) {
    await redis.lpush(LOG_KEY, log);
    await redis.ltrim(LOG_KEY, 0, getMaxLogs() - 1);

    return log;
  }

  const logs = getStore();
  logs.unshift(log);
  logs.splice(getMaxLogs());

  return log;
}

export async function getApiDebugLogs(filter: ApiDebugStatusFilter = "all") {
  const redis = getRedis();

  if (redis) {
    const logs = await redis.lrange<ApiDebugLog>(LOG_KEY, 0, getMaxLogs() - 1);
    return filterLogs(logs, filter);
  }

  return filterLogs(getStore(), filter);
}

export async function clearApiDebugLogs() {
  const redis = getRedis();

  if (redis) {
    await redis.del(LOG_KEY);
    return;
  }

  getStore().splice(0);
}
