"use client";

import { useEffect, useState, useCallback } from "react";

interface Summary {
  totalRuns: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCostUsd: number;
}

interface AgentUsage {
  agentId: string;
  agentName: string | null;
  runCount: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  avgDurationMs: number;
}

export function UsageClient() {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [byAgent, setByAgent] = useState<AgentUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from, to });
      const [summaryRes, agentRes] = await Promise.all([
        fetch(`/api/usage/summary?${params}`),
        fetch(`/api/usage/by-agent?${params}`),
      ]);
      if (!summaryRes.ok) throw new Error(`HTTP ${summaryRes.status}`);
      setSummary(await summaryRes.json());
      if (agentRes.ok) setByAgent(await agentRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Usage &amp; Spend</h1>
          <p className="text-sm text-gray-500 mt-1">Token usage and cost per agent</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <label className="text-xs text-gray-500">To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            onClick={fetchUsage}
            className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Total Runs</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{summary.totalRuns.toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Input Tokens</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{summary.totalTokensInput.toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Output Tokens</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{summary.totalTokensOutput.toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Total Cost (USD)</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">${summary.totalCostUsd.toFixed(4)}</p>
          </div>
        </div>
      )}

      {/* Per-agent breakdown */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Usage by Agent</h2>
        </div>
        {loading ? (
          <div className="p-8 text-center text-gray-400 animate-pulse">Loading...</div>
        ) : byAgent.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No runs in this date range.</div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Agent</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Runs</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Input Tokens</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Output Tokens</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Avg Duration</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Cost (USD)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {byAgent.map((row) => (
                <tr key={row.agentId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{row.agentName ?? row.agentId.slice(0, 8)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{row.runCount.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{row.tokensInput.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{row.tokensOutput.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">
                    {row.avgDurationMs > 0 ? `${(row.avgDurationMs / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-900">${row.costUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
