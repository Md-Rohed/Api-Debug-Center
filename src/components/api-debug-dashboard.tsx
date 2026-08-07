"use client";

import {
  Activity,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Pause,
  Play,
  RefreshCw,
  Server,
  Trash2,
  User,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ApiDebugLogSummary, ApiDebugStatusFilter } from "@/lib/types";

type LogsResponse = {
  logs: ApiDebugLogSummary[];
  count: number;
  storage: "redis" | "memory";
  timestamp: string;
  sessionId: string;
};

const filters: ApiDebugStatusFilter[] = ["all", "success", "failed"];

/** Every poll costs one Redis command against the plan's monthly budget, so
 *  keep it modest. Overridable at build time for local debugging. */
const REFRESH_INTERVAL_MS = Number(process.env.NEXT_PUBLIC_DEBUG_REFRESH_MS) || 5000;

const SESSION_STORAGE_KEY = "erp-debug-developer-email";
type CopyTarget = "request" | "response";

function readSavedEmail(): string {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveEmail(email: string) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, email);
  } catch {
    // Ignore
  }
}

function formatStatus(log: ApiDebugLogSummary) {
  return log.status === null ? "Network" : String(log.status);
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatPayload(value: unknown) {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function ApiDebugDashboard() {
  const [filter, setFilter] = useState<ApiDebugStatusFilter>("all");
  const [logs, setLogs] = useState<ApiDebugLogSummary[]>([]);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  // Bodies arrive only for the selected log, so hold onto the ones we've been
  // sent — otherwise re-selecting a log blanks the detail pane until the next poll.
  const [detailCache, setDetailCache] = useState<Record<string, ApiDebugLogSummary>>({});
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [storage, setStorage] = useState<LogsResponse["storage"]>("memory");
  const [copyStatus, setCopyStatus] = useState<{
    target: CopyTarget;
    state: "copied" | "failed";
  } | null>(null);
  const copyStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Developer email — used as the per-developer sessionId.
  // Populated from localStorage on first render.
  const [developerEmail, setDeveloperEmail] = useState("");
  const emailInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDeveloperEmail(readSavedEmail());
  }, []);

  useEffect(
    () => () => {
      if (copyStatusTimerRef.current) clearTimeout(copyStatusTimerRef.current);
    },
    []
  );

  const copyPayload = useCallback(async (target: CopyTarget, value: unknown) => {
    try {
      await navigator.clipboard.writeText(formatPayload(value));
      setCopyStatus({ target, state: "copied" });
    } catch {
      setCopyStatus({ target, state: "failed" });
    }

    if (copyStatusTimerRef.current) clearTimeout(copyStatusTimerRef.current);
    copyStatusTimerRef.current = setTimeout(() => setCopyStatus(null), 2000);
  }, []);

  const listedLog = logs.find((log) => log.id === selectedLogId) ?? logs[0] ?? null;
  // Prefer the cached copy: it's the one that actually carries the bodies.
  const selectedLog = listedLog ? (detailCache[listedLog.id] ?? listedLog) : null;

  const metrics = useMemo(() => {
    const successCount = logs.filter((log) => log.success).length;
    const failedCount = logs.length - successCount;
    const averageDuration =
      logs.length === 0
        ? 0
        : Math.round(logs.reduce((total, log) => total + log.durationMs, 0) / logs.length);

    return {
      total: logs.length,
      successCount,
      failedCount,
      averageDuration,
    };
  }, [logs]);

  const loadLogs = useCallback(async () => {
    if (!developerEmail.trim()) {
      setLoading(false);
      return;
    }

    try {
      setError(null);
      const params = new URLSearchParams({
        status: filter,
        sessionId: developerEmail.trim(),
      });
      // Ask for full bodies on the open log only.
      if (selectedLogId) params.set("detailId", selectedLogId);

      const response = await fetch(`/api/logs?${params}`, { cache: "no-store" });

      if (!response.ok) {
        // The route reports storage problems as a readable message; prefer it
        // over the bare status code.
        const detail = await response
          .json()
          .then((body) => (body as { error?: string }).error)
          .catch(() => null);

        throw new Error(detail ?? `Dashboard fetch failed with status ${response.status}`);
      }

      const data = (await response.json()) as LogsResponse;
      setLogs(data.logs);
      setStorage(data.storage);
      setLastUpdated(data.timestamp);
      setSelectedLogId((current) => {
        if (current && data.logs.some((log) => log.id === current)) return current;
        return data.logs[0]?.id ?? null;
      });

      const expanded = data.logs.filter((log) => !log.truncated);
      if (expanded.length > 0) {
        setDetailCache((current) => {
          const next = { ...current };
          for (const log of expanded) next[log.id] = log;
          return next;
        });
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Unable to load logs");
    } finally {
      setLoading(false);
    }
  }, [filter, developerEmail, selectedLogId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadLogs();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [loadLogs]);

  useEffect(() => {
    if (!autoRefresh) return;

    const interval = window.setInterval(() => {
      void loadLogs();
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [autoRefresh, loadLogs]);

  async function clearLogs() {
    if (!developerEmail.trim()) return;

    const params = new URLSearchParams({ sessionId: developerEmail.trim() });
    await fetch(`/api/logs?${params}`, { method: "DELETE" });
    setLogs([]);
    setSelectedLogId(null);
    setDetailCache({});
    setLastUpdated(new Date().toISOString());
  }

  function handleEmailChange(value: string) {
    setDeveloperEmail(value);
    saveEmail(value);
    // Reset log state so the new session loads cleanly
    setLogs([]);
    setSelectedLogId(null);
    setDetailCache({});
    setLoading(true);
  }

  return (
    <main className="debug-shell">
      <header className="debug-header">
        <div>
          <div className="debug-kicker">
            <Server size={16} aria-hidden="true" />
            Petra ERP QA · {storage}
          </div>
          <h1>ERP API Debug Center</h1>
        </div>
        <div className="debug-actions">
          <div className="developer-identity">
            <User size={15} aria-hidden="true" />
            <input
              ref={emailInputRef}
              type="email"
              placeholder="Your ERP login email…"
              value={developerEmail}
              onChange={(e) => handleEmailChange(e.target.value)}
              aria-label="Developer email — scopes logs to your session"
              className="developer-email-input"
            />
          </div>
          <label className="auto-refresh-control">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            {autoRefresh ? (
              <Play size={16} aria-hidden="true" />
            ) : (
              <Pause size={16} aria-hidden="true" />
            )}
            Live
          </label>
          <button
            className="icon-button"
            type="button"
            onClick={() => void loadLogs()}
            title="Refresh"
          >
            <RefreshCw size={17} aria-hidden="true" />
            Refresh
          </button>
          <button
            className="icon-button danger"
            type="button"
            onClick={() => void clearLogs()}
            title="Clear logs"
          >
            <Trash2 size={17} aria-hidden="true" />
            Clear
          </button>
        </div>
      </header>

      <section className="metric-grid" aria-label="API log summary">
        <article className="metric-card">
          <Activity size={18} aria-hidden="true" />
          <span>Total</span>
          <strong>{metrics.total}</strong>
        </article>
        <article className="metric-card success">
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>Success</span>
          <strong>{metrics.successCount}</strong>
        </article>
        <article className="metric-card failed">
          <XCircle size={18} aria-hidden="true" />
          <span>Failed</span>
          <strong>{metrics.failedCount}</strong>
        </article>
        <article className="metric-card">
          <Clock3 size={18} aria-hidden="true" />
          <span>Avg duration</span>
          <strong>{metrics.averageDuration}ms</strong>
        </article>
      </section>

      <section className="workspace-grid">
        <div className="log-list-panel">
          <div className="panel-toolbar">
            <div className="segmented-control" aria-label="Filter logs">
              {filters.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <span className="last-updated">
              {lastUpdated ? `Updated ${formatTimestamp(lastUpdated)}` : "Waiting"}
            </span>
          </div>

          {error ? <div className="status-banner failed">{error}</div> : null}
          {!developerEmail.trim() ? (
            <div className="status-banner configure">
              Enter your ERP login email above to see your API logs.
            </div>
          ) : null}
          {developerEmail.trim() && loading ? (
            <div className="empty-state">Loading logs</div>
          ) : null}
          {developerEmail.trim() && !loading && logs.length === 0 ? (
            <div className="empty-state">No API logs</div>
          ) : null}

          {logs.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>State</th>
                    <th>Method</th>
                    <th>Endpoint</th>
                    <th>Status</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr
                      key={log.id}
                      className={selectedLog?.id === log.id ? "selected" : ""}
                      onClick={() => setSelectedLogId(log.id)}
                    >
                      <td>{formatTimestamp(log.timestamp)}</td>
                      <td>
                        <span className={log.success ? "state-pill success" : "state-pill failed"}>
                          {log.success ? "Success" : "Failed"}
                        </span>
                      </td>
                      <td>
                        <span className="method-pill">{log.method}</span>
                      </td>
                      <td className="endpoint-cell">{log.endpoint}</td>
                      <td>{formatStatus(log)}</td>
                      <td>{log.durationMs}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <aside className="detail-panel" aria-label="Selected API log">
          {selectedLog ? (
            <>
              <div className="detail-heading">
                <div>
                  <span
                    className={selectedLog.success ? "state-pill success" : "state-pill failed"}
                  >
                    {selectedLog.success ? "Success" : "Failed"}
                  </span>
                  <h2>{selectedLog.endpoint}</h2>
                </div>
                <span className="method-pill">{selectedLog.method}</span>
              </div>

              <dl className="detail-grid">
                <div>
                  <dt>Status</dt>
                  <dd>{formatStatus(selectedLog)}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>{selectedLog.durationMs}ms</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{selectedLog.source}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>{selectedLog.environment}</dd>
                </div>
                <div className="wide">
                  <dt>Timestamp</dt>
                  <dd>{formatDateTime(selectedLog.timestamp)}</dd>
                </div>
              </dl>

              {selectedLog.errorMessage ? (
                <section className="payload-section">
                  <h3>Error</h3>
                  <pre>{selectedLog.errorMessage}</pre>
                </section>
              ) : null}

              <section className="payload-section">
                <div className="payload-heading">
                  <h3>Request body</h3>
                  <button
                    className="copy-button"
                    type="button"
                    onClick={() => void copyPayload("request", selectedLog.requestBody)}
                    aria-label="Copy request body"
                  >
                    {copyStatus?.target === "request" && copyStatus.state === "copied" ? (
                      <Check size={14} aria-hidden="true" />
                    ) : (
                      <Copy size={14} aria-hidden="true" />
                    )}
                    {copyStatus?.target === "request"
                      ? copyStatus.state === "copied"
                        ? "Copied"
                        : "Copy failed"
                      : "Copy"}
                  </button>
                </div>
                <pre>{formatPayload(selectedLog.requestBody)}</pre>
              </section>

              <section className="payload-section">
                <div className="payload-heading">
                  <h3>Response body</h3>
                  <button
                    className="copy-button"
                    type="button"
                    onClick={() => void copyPayload("response", selectedLog.responseBody)}
                    aria-label="Copy response body"
                  >
                    {copyStatus?.target === "response" && copyStatus.state === "copied" ? (
                      <Check size={14} aria-hidden="true" />
                    ) : (
                      <Copy size={14} aria-hidden="true" />
                    )}
                    {copyStatus?.target === "response"
                      ? copyStatus.state === "copied"
                        ? "Copied"
                        : "Copy failed"
                      : "Copy"}
                  </button>
                </div>
                <pre>{formatPayload(selectedLog.responseBody)}</pre>
              </section>
            </>
          ) : (
            <div className="empty-state">Select a log</div>
          )}
        </aside>
      </section>
    </main>
  );
}
