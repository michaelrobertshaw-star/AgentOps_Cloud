"use client";

import { useEffect, useState, useCallback } from "react";

interface DashboardData {
  company: { id: string; name: string; displayName: string };
  agents: {
    total: number;
    active: number;
    paused: number;
    error: number;
    draft: number;
    testing: number;
  };
  tasks: {
    total24h: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  departments: Array<{
    id: string;
    name: string;
    status: string;
    agentCount: number;
    taskCount24h: number;
  }>;
}

interface IncidentCounts {
  open: number;
  investigating: number;
  resolved: number;
  total: number;
}

interface IncidentPage {
  data: Array<{ status: string }>;
  total: number;
}

export function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [incidents, setIncidents] = useState<IncidentCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch("/api/companies/me/dashboard");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as DashboardData;
      setData(json);
      setLastUpdated(new Date());
      setError(null);

      // Fetch incident counts across all active departments
      const activeDepts = json.departments.filter((d) => d.status === "active");
      const incidentResults = await Promise.all(
        activeDepts.map(async (dept) => {
          const r = await fetch(`/api/departments/${dept.id}/incidents?limit=500`);
          if (!r.ok) return [];
          const page: IncidentPage = await r.json();
          return page.data;
        }),
      );
      const allIncidents = incidentResults.flat();
      const counts: IncidentCounts = { open: 0, investigating: 0, resolved: 0, total: allIncidents.length };
      for (const inc of allIncidents) {
        if (inc.status === "open") counts.open++;
        else if (inc.status === "investigating") counts.investigating++;
        else if (inc.status === "resolved") counts.resolved++;
      }
      setIncidents(counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard");
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(fetchDashboard, 30_000);
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 bg-gray-200 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{data.company.displayName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Company overview &nbsp;&middot;&nbsp;
            {lastUpdated && <span>Last updated {lastUpdated.toLocaleTimeString()}</span>}
          </p>
        </div>
        <button
          onClick={fetchDashboard}
          className="text-sm text-brand-600 hover:text-brand-700 font-medium"
        >
          Refresh
        </button>
      </div>

      {/* Agent status cards */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Agents
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Total" value={data.agents.total} color="gray" />
          <StatCard label="Active" value={data.agents.active} color="green" />
          <StatCard label="Paused" value={data.agents.paused} color="yellow" />
          <StatCard label="Error" value={data.agents.error} color="red" />
        </div>
      </section>

      {/* Task counts (24h) */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Tasks &mdash; last 24 h
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Pending" value={data.tasks.pending} color="gray" />
          <StatCard label="Running" value={data.tasks.running} color="blue" />
          <StatCard label="Completed" value={data.tasks.completed} color="green" />
          <StatCard label="Failed" value={data.tasks.failed} color="red" />
        </div>
      </section>

      {/* Incident counts */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Incidents
        </h2>
        {incidents ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Total" value={incidents.total} color="gray" />
            <StatCard label="Open" value={incidents.open} color="red" />
            <StatCard label="Investigating" value={incidents.investigating} color="yellow" />
            <StatCard label="Resolved" value={incidents.resolved} color="green" />
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />
            ))}
          </div>
        )}
      </section>

      {/* Department table */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Departments
        </h2>
        {data.departments.length === 0 ? (
          <p className="text-sm text-gray-400">No departments yet.</p>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Agents
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Tasks (24 h)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.departments.map((dept) => (
                  <tr key={dept.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{dept.name}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={dept.status} />
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">{dept.agentCount}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{dept.taskCount24h}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: "gray" | "green" | "yellow" | "red" | "blue";
}) {
  const colorMap = {
    gray: "bg-gray-50 border-gray-200",
    green: "bg-green-50 border-green-200",
    yellow: "bg-yellow-50 border-yellow-200",
    red: "bg-red-50 border-red-200",
    blue: "bg-blue-50 border-blue-200",
  };
  const valueColorMap = {
    gray: "text-gray-900",
    green: "text-green-700",
    yellow: "text-yellow-700",
    red: "text-red-700",
    blue: "text-blue-700",
  };

  return (
    <div className={`rounded-xl border p-5 shadow-sm ${colorMap[color]}`}>
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${valueColorMap[color]}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    archived: "bg-gray-100 text-gray-500",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
        map[status] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {status}
    </span>
  );
}
