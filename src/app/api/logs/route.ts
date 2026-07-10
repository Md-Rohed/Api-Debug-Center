import { timingSafeEqual } from "node:crypto";

import {
  addApiDebugLog,
  clearApiDebugLogs,
  getApiDebugLogs,
  getApiDebugStorageMode,
} from "@/lib/log-store";
import type { ApiDebugLogPayload, ApiDebugStatusFilter } from "@/lib/types";
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

/** Resolve and validate the sessionId from a request.
 *  Falls back to SHARED_INGEST_SESSION if none is provided. */
function resolveSessionId(request: NextRequest): string {
  const raw = request.nextUrl.searchParams.get("sessionId");
  if (!raw) return SHARED_INGEST_SESSION;

  // Allow UUID chars plus email-safe chars (letters, digits, -, _, ., @, +)
  const sanitized = raw.replace(/[^a-zA-Z0-9-_.@+]/g, "");
  return sanitized.length > 0 ? sanitized : SHARED_INGEST_SESSION;
}

export async function GET(request: NextRequest) {
  const sessionId = resolveSessionId(request);
  const filter = parseStatusFilter(request.nextUrl.searchParams.get("status"));
  const logs = await getApiDebugLogs(sessionId, filter);

  return Response.json({
    logs,
    count: logs.length,
    maxLogs: Number(process.env.DEBUG_CENTER_MAX_LOGS || 300),
    storage: getApiDebugStorageMode(),
    timestamp: new Date().toISOString(),
    sessionId,
  });
}

export async function POST(request: NextRequest) {
  if (!secretMatches(request.headers.get("x-erp-debug-secret"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = (await request.json()) as Partial<ApiDebugLogPayload>;
    // Use the sessionId from the URL (set by ERP api-client via developer email).
    // Falls back to SHARED_INGEST_SESSION when no sessionId is supplied.
    const sessionId = resolveSessionId(request);
    const log = await addApiDebugLog(payload, sessionId);

    return Response.json({ ok: true, logId: log.id });
  } catch {
    return Response.json({ error: "Invalid log payload" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const sessionId = resolveSessionId(request);
  await clearApiDebugLogs(sessionId);
  return Response.json({ ok: true, sessionId });
}
