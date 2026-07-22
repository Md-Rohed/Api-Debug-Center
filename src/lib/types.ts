export type ApiDebugStatusFilter = "all" | "success" | "failed";

export type ApiDebugLog = {
  id: string;
  timestamp: string;
  source: string;
  environment: string;
  method: string;
  endpoint: string;
  status: number | null;
  durationMs: number;
  success: boolean;
  requestBody: unknown;
  responseBody: unknown;
  errorMessage: string | null;
};

export type ApiDebugLogPayload = Omit<ApiDebugLog, "id">;

/** A log as returned by the list endpoint. Request/response bodies are omitted
 *  for every entry except the one the dashboard currently has open — sending
 *  300 full bodies on every poll is what exhausts the Redis bandwidth quota.
 *  `truncated` distinguishes "body was stripped" from "body was genuinely null". */
export type ApiDebugLogSummary = Omit<ApiDebugLog, "requestBody" | "responseBody"> & {
  requestBody?: unknown;
  responseBody?: unknown;
  truncated?: boolean;
};
