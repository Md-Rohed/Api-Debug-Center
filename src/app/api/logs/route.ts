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

export async function GET(request: NextRequest) {
  const filter = parseStatusFilter(request.nextUrl.searchParams.get("status"));
  const logs = await getApiDebugLogs(filter);

  return Response.json({
    logs,
    count: logs.length,
    maxLogs: Number(process.env.DEBUG_CENTER_MAX_LOGS || 300),
    storage: getApiDebugStorageMode(),
    timestamp: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get("x-erp-debug-secret"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = (await request.json()) as Partial<ApiDebugLogPayload>;
    const log = await addApiDebugLog(payload);

    return Response.json({ ok: true, logId: log.id });
  } catch {
    return Response.json({ error: "Invalid log payload" }, { status: 400 });
  }
}

export async function DELETE() {
  await clearApiDebugLogs();
  return Response.json({ ok: true });
}
