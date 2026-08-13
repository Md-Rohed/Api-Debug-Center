import { timingSafeEqual } from "node:crypto";

import {
  addApiDebugLog,
  ApiDebugStorageError,
  clearApiDebugLogs,
  getApiDebugLogs,
  getApiDebugStorageMode,
} from "@/lib/log-store";
import type { ApiDebugLogPayload, ApiDebugMethodFilter, ApiDebugStatusFilter } from "@/lib/types";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** Fallback session used by the POST ingest route (server-side callers).
 *  All ERP backend logs land here; each developer's dashboard reads their
 *  own session key, so they each get an independent copy / clear action. */
const SHARED_INGEST_SESSION = "shared";

function secretMatches(receivedSecret: string | null) {
  const expectedSecret = process.env.ERP_API_DEBUG_SHARED_SECRET;

  if (!receivedSecret || !expectedSecret) return false;

  const received = Buffer.from(receivedSecret);
  const expected = Buffer.from(expectedSecret);

  return received.length === expected.length && timingSafeEqual(received, expected);
}

function parseStatusFilter(value: string | null): ApiDebugStatusFilter {
  if (value === "success" || value === "failed") return value;
  return "all";
}

function parseMethodFilter(value: string | null): ApiDebugMethodFilter {
  if (value === "GET" || value === "POST" || value === "PUT") return value;
  return "all";
}

/** Resolve and validate the sessionId from a request.
 *  Falls back to SHARED_INGEST_SESSION if none is provided. */
function resolveSessionId(request: NextRequest): string {
  const raw = request.nextUrl.searchParams.get("sessionId");
  if (!raw) return SHARED_INGEST_SESSION;

  // Allow UUID chars plus email-safe chars (letters, digits, -, _, ., @, +)
  const sanitized = raw.replace(/[^a-zA-Z0-9-_.@+]/g, "");
  return sanitized.length > 0 ? sanitized : SHARED_INGEST_SESSION;
}

/** Turns a storage failure into a readable response instead of an opaque 500.
 *  503 tells the dashboard this is transient and worth retrying. */
function storageErrorResponse(error: unknown) {
  const message =
    error instanceof ApiDebugStorageError ? error.message : "Log storage is unavailable";

  console.error("[api/logs] storage failure:", error);

  return Response.json(
    { error: message, quotaExceeded: error instanceof ApiDebugStorageError && error.quotaExceeded },
    { status: 503 }
  );
}

export async function GET(request: NextRequest) {
  const sessionId = resolveSessionId(request);
  const filter = parseStatusFilter(request.nextUrl.searchParams.get("status"));
  const method = parseMethodFilter(request.nextUrl.searchParams.get("method"));
  // The dashboard sends the log it currently has open; only that one comes
  // back with full request/response bodies.
  const detailId = request.nextUrl.searchParams.get("detailId");

  try {
    const logs = await getApiDebugLogs(sessionId, filter, detailId, method);

    return Response.json({
      logs,
      count: logs.length,
      maxLogs: Number(process.env.DEBUG_CENTER_MAX_LOGS || 300),
      storage: getApiDebugStorageMode(),
      timestamp: new Date().toISOString(),
      sessionId,
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  if (!secretMatches(request.headers.get("x-erp-debug-secret"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: Partial<ApiDebugLogPayload>;

  try {
    payload = (await request.json()) as Partial<ApiDebugLogPayload>;
  } catch {
    return Response.json({ error: "Invalid log payload" }, { status: 400 });
  }

  try {
    // Use the sessionId from the URL (set by ERP api-client via developer email).
    // Falls back to SHARED_INGEST_SESSION when no sessionId is supplied.
    const sessionId = resolveSessionId(request);
    const log = await addApiDebugLog(payload, sessionId);

    return Response.json({ ok: true, logId: log.id });
  } catch (error) {
    // A storage outage is not the caller's fault — don't report it as a 400.
    return storageErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const sessionId = resolveSessionId(request);

  try {
    await clearApiDebugLogs(sessionId);
  } catch (error) {
    return storageErrorResponse(error);
  }

  return Response.json({ ok: true, sessionId });
}
