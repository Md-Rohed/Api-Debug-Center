"use client";

import {
  Activity,
  CheckCircle2,
  Clock3,
  Pause,
  Play,
  RefreshCw,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ApiDebugLog, ApiDebugStatusFilter } from "@/lib/types";

type LogsResponse = {
  logs: ApiDebugLog[];
  count: number;
  storage: "redis" | "memory";
  timestamp: string;
};

const filters: ApiDebugStatusFilter[] = ["all", "success", "failed"];

function formatStatus(log: ApiDebugLog) {
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
  const [logs, setLogs] = useState<ApiDebugLog[]>([]);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [storage, setStorage] = useState<LogsResponse["storage"]>("memory");

  const selectedLog = logs.find((log) => log.id === selectedLogId) ?? logs[0] ?? null;

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
    try {
      setError(null);
      const response = await fetch(`/api/logs?status=${filter}`, { cache: "no-store" });

      if (!response.ok) {
        throw new Error(`Dashboard fetch failed with status ${response.status}`);
      }

      const data = (await response.json()) as LogsResponse;
      setLogs(data.logs);
      setStorage(data.storage);
      setLastUpdated(data.timestamp);
      setSelectedLogId((current) => {
        if (current && data.logs.some((log) => log.id === current)) return current;
        return data.logs[0]?.id ?? null;
      });
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Unable to load logs");
    } finally {
      setLoading(false);
    }
  }, [filter]);

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
    }, 1500);

    return () => window.clearInterval(interval);
  }, [autoRefresh, loadLogs]);

  async function clearLogs() {
    await fetch("/api/logs", { method: "DELETE" });
    setLogs([]);
    setSelectedLogId(null);
    setLastUpdated(new Date().toISOString());
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
          {loading ? <div className="empty-state">Loading logs</div> : null}
          {!loading && logs.length === 0 ? <div className="empty-state">No API logs</div> : null}

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
                <h3>Request body</h3>
                <pre>{formatPayload(selectedLog.requestBody)}</pre>
              </section>

              <section className="payload-section">
                <h3>Response body</h3>
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
