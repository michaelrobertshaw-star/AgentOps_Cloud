"use client";

import { useEffect, useState, useCallback } from "react";

interface Department {
  id: string;
  name: string;
  status: string;
}

interface Incident {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  departmentId: string;
  departmentName?: string;
  createdAt: string;
  resolvedAt: string | null;
}

interface IncidentPage {
  data: Incident[];
  total: number;
  page: number;
  limit: number;
}

export function IncidentsClient() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const deptsRes = await fetch("/api/departments");
      if (!deptsRes.ok) throw new Error(`Departments: HTTP ${deptsRes.status}`);
      const depts: Department[] = await deptsRes.json();
      setDepartments(depts);

      const activeDepts = depts.filter((d) => d.status === "active");
      const results = await Promise.all(
        activeDepts.map(async (dept) => {
          const res = await fetch(`/api/departments/${dept.id}/incidents?limit=100`);
          if (!res.ok) return [];
          const page: IncidentPage = await res.json();
          return page.data.map((i) => ({ ...i, departmentName: dept.name }));
        }),
      );

      const all = results.flat().sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      setIncidents(all);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load incidents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-40 bg-gray-200 rounded" />
        <div className="h-48 bg-gray-200 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Incidents</h1>
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Incidents</h1>
        <button
          onClick={fetchAll}
          className="text-sm text-brand-600 hover:text-brand-700 font-medium"
        >
          Refresh
        </button>
      </div>

      {incidents.length === 0 ? (
        <p className="text-sm text-gray-400">No incidents found.</p>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Title
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Severity
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Department
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {incidents.map((inc) => (
                <tr key={inc.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{inc.title}</div>
                    <div className="text-xs text-gray-400 truncate max-w-xs">{inc.description}</div>
                  </td>
                  <td className="px-4 py-3">
                    <SeverityBadge severity={inc.severity} />
                  </td>
                  <td className="px-4 py-3">
                    <IncidentStatusBadge status={inc.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-600">{inc.departmentName ?? inc.departmentId}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {new Date(inc.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: "bg-red-100 text-red-700",
    high: "bg-orange-100 text-orange-700",
    medium: "bg-yellow-100 text-yellow-700",
    low: "bg-blue-100 text-blue-700",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
        map[severity] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {severity}
    </span>
  );
}

function IncidentStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: "bg-red-100 text-red-700",
    investigating: "bg-yellow-100 text-yellow-700",
    mitigated: "bg-blue-100 text-blue-700",
    resolved: "bg-green-100 text-green-700",
    closed: "bg-gray-100 text-gray-500",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
        map[status] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {status}
    </span>
  );
}
