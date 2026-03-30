"use client";

import { useEffect, useState, useCallback } from "react";

interface Summary {
  totalRuns: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCostUsd: number;
  spendCapUsd: number | null;
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

interface DailyPoint {
  date: string;
  runCount: number;
  costUsd: number;
}

/** Minimal SVG line chart */
function LineChart({ data, width = 600, height = 120 }: { data: DailyPoint[]; width?: number; height?: number }) {
  if (data.length === 0) {
    return <div className="h-28 flex items-center justify-center text-xs text-gray-300">No data in range</div>;
  }
  const padX = 12;
  const padY = 10;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;
  const maxCost = Math.max(...data.map((d) => d.costUsd), 0.0001);

  const pts = data.map((d, i) => {
    const x = padX + (i / Math.max(data.length - 1, 1)) * chartW;
    const y = padY + chartH - (d.costUsd / maxCost) * chartH;
    return { x, y, d };
  });

  const polyline = pts.map((p) => `${p.x},${p.y}`).join(" ");

  // Fill area below line
  const areaPoints = [
    `${pts[0].x},${padY + chartH}`,
    ...pts.map((p) => `${p.x},${p.y}`),
    `${pts[pts.length - 1].x},${padY + chartH}`,
  ].join(" ");

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <defs>
        <linearGradient id="usageGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Grid lines */}
      {[0, 0.5, 1].map((frac) => {
        const y = padY + frac * chartH;
        return (
          <line key={frac} x1={padX} x2={padX + chartW} y1={y} y2={y}
            stroke="#e5e7eb" strokeWidth="1" strokeDasharray="4 4" />
        );
      })}
      {/* Area fill */}
      <polygon points={areaPoints} fill="url(#usageGrad)" />
      {/* Line */}
      <polyline points={polyline} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinejoin="round" />
      {/* Data points */}
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="#6366f1">
          <title>{`${p.d.date}: $${p.d.costUsd.toFixed(4)} (${p.d.runCount} runs)`}</title>
        </circle>
      ))}
    </svg>
  );
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
  const [dailyData, setDailyData] = useState<DailyPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from, to });
      const [summaryRes, agentRes, dailyRes] = await Promise.all([
        fetch(`/api/usage/summary?${params}`),
        fetch(`/api/usage/by-agent?${params}`),
        fetch(`/api/usage/daily?${params}`),
      ]);
      if (!summaryRes.ok) throw new Error(`HTTP ${summaryRes.status}`);
      setSummary(await summaryRes.json());
      if (agentRes.ok) setByAgent(await agentRes.json());
      if (dailyRes.ok) setDailyData(await dailyRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  // Spend cap warning logic
  const spendCapBanner = (() => {
    if (!summary || !summary.spendCapUsd || summary.spendCapUsd <= 0) return null;
    const pct = (summary.totalCostUsd / summary.spendCapUsd) * 100;
    if (pct >= 100) {
      return (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-300 px-4 py-3 flex items-center gap-3">
          <span className="text-red-600 text-lg">⛔</span>
          <div>
            <p className="text-sm font-semibold text-red-700">Spend cap reached — new runs are blocked</p>
            <p className="text-xs text-red-600">
              ${summary.totalCostUsd.toFixed(2)} of ${summary.spendCapUsd.toFixed(2)} monthly cap used ({pct.toFixed(0)}%).
            </p>
          </div>
        </div>
      );
    }
    if (pct >= 80) {
      return (
        <div className="mb-4 rounded-lg bg-yellow-50 border border-yellow-300 px-4 py-3 flex items-center gap-3">
          <span className="text-yellow-600 text-lg">⚠️</span>
          <div>
            <p className="text-sm font-semibold text-yellow-700">Approaching spend cap</p>
            <p className="text-xs text-yellow-600">
              ${summary.totalCostUsd.toFixed(2)} of ${summary.spendCapUsd.toFixed(2)} monthly cap used ({pct.toFixed(0)}%).
            </p>
          </div>
        </div>
      );
    }
    return null;
  })();

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

      {/* Spend cap warning banner */}
      {spendCapBanner}

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Total Runs</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{summary.totalRuns.toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Total Tokens</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">
              {(summary.totalTokensInput + summary.totalTokensOutput).toLocaleString()}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              {summary.totalTokensInput.toLocaleString()} in / {summary.totalTokensOutput.toLocaleString()} out
            </p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Total Cost (USD)</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">${summary.totalCostUsd.toFixed(4)}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Spend Cap</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">
              {summary.spendCapUsd ? `$${summary.spendCapUsd.toFixed(2)}/mo` : "—"}
            </p>
            {summary.spendCapUsd && summary.spendCapUsd > 0 && (
              <div className="mt-2">
                <div className="w-full bg-gray-100 rounded-full h-1.5">
                  <div
                    className={`h-1.5 rounded-full ${
                      summary.totalCostUsd / summary.spendCapUsd >= 1
                        ? "bg-red-500"
                        : summary.totalCostUsd / summary.spendCapUsd >= 0.8
                        ? "bg-yellow-400"
                        : "bg-brand-500"
                    }`}
                    style={{ width: `${Math.min((summary.totalCostUsd / summary.spendCapUsd) * 100, 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cost over time chart */}
      {!loading && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm mb-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Cost Over Time</h2>
          <LineChart data={dailyData} />
          {dailyData.length > 0 && (
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>{dailyData[0]?.date}</span>
              <span>{dailyData[dailyData.length - 1]?.date}</span>
            </div>
          )}
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
