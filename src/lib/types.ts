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
