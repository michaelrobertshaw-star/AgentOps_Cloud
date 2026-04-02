"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

interface AuditLogEntry {
  id: string;
  createdAt: string;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  companyId: string;
  ipAddress: string | null;
  outcome: string;
  riskLevel: string;
}

interface AuditLogPage {
  data: AuditLogEntry[];
  total: number;
  nextCursor?: string | null;
}

const PAGE_SIZE = 50;

const KNOWN_ACTIONS = [
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "agent.deployed",
  "agent.stopped",
  "skill.created",
  "skill.updated",
  "skill.deleted",
  "user.login",
  "user.logout",
  "company.updated",
];

export default function AuditLogsPage() {
  const searchParams = useSearchParams();

  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [fromDate, setFromDate] = useState(searchParams.get("from") ?? "");
  const [toDate, setToDate] = useState(searchParams.get("to") ?? "");
  const [action, setAction] = useState(searchParams.get("action") ?? "");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursors, setCursors] = useState<string[]>([]); // cursor history for pagination

  const fetchLogs = useCallback(
    async (opts: { cursor?: string | null } = {}) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        if (fromDate) params.set("from", fromDate);
        if (toDate) params.set("to", toDate);
        if (action) params.set("action", action);
        if (opts.cursor) params.set("cursor", opts.cursor);

        const res = await fetchWithTenant(`/api/audit-logs?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: AuditLogPage = await res.json();
        setLogs(data.data ?? []);
        setTotal(data.total ?? 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load audit logs");
      } finally {
        setLoading(false);
      }
    },
    [fromDate, toDate, action],
  );

  useEffect(() => {
    fetchLogs({ cursor: null });
    setCursors([]);
    setCursor(null);
  }, [fetchLogs]);

  function handleApply() {
    setCursors([]);
    setCursor(null);
    fetchLogs({ cursor: null });
  }

  const currentPage = cursors.length + 1;
  const hasMore = logs.length === PAGE_SIZE;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Audit Logs</h1>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-5 flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Action</label>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">All actions</option>
            {KNOWN_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={handleApply}
          className="px-4 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Apply
        </button>
        <button
          onClick={() => {
            setFromDate("");
            setToDate("");
            setAction("");
          }}
          className="px-4 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-medium rounded-lg transition-colors"
        >
          Clear
        </button>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 animate-pulse">Loading audit logs...</div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No audit log entries found.</div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                  Timestamp
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Actor
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Action
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Object Type
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Object ID
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  IP Address
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Outcome
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {logs.map((entry) => (
                <tr key={entry.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs font-medium text-gray-800 truncate max-w-[140px]">
                      {entry.actorId.slice(0, 8)}&hellip;
                    </div>
                    <div className="text-xs text-gray-400">{entry.actorType}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                      {entry.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">{entry.resourceType}</td>
                  <td className="px-4 py-3 text-xs text-gray-400 font-mono truncate max-w-[120px]">
                    {entry.resourceId.slice(0, 8)}&hellip;
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                    {entry.ipAddress ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <OutcomeBadge outcome={entry.outcome} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {!loading && (
        <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
          <span>
            Page {currentPage} &mdash; showing {logs.length} entries
            {total > 0 && ` of ${total} total`}
          </span>
          <div className="flex gap-2">
            <button
              disabled={cursors.length === 0}
              onClick={() => {
                const prev = cursors.slice(0, -1);
                const prevCursor = prev[prev.length - 1] ?? null;
                setCursors(prev);
                setCursor(prevCursor);
                fetchLogs({ cursor: prevCursor });
              }}
              className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              &larr; Prev
            </button>
            <button
              disabled={!hasMore}
              onClick={() => {
                if (logs.length > 0) {
                  const nextCursor = logs[logs.length - 1].id;
                  setCursors((prev) => [...prev, nextCursor]);
                  setCursor(nextCursor);
                  fetchLogs({ cursor: nextCursor });
                }
              }}
              className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              Next &rarr;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const map: Record<string, string> = {
    success: "bg-green-50 text-green-700",
    failure: "bg-red-50 text-red-700",
    denied: "bg-orange-50 text-orange-700",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
        map[outcome] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {outcome}
    </span>
  );
}
