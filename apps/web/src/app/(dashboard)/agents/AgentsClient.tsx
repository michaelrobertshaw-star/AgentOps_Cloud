"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

interface Department {
  id: string;
  name: string;
  status: string;
}

interface Agent {
  id: string;
  name: string;
  type: string;
  version: string | null;
  status: string;
  departmentId: string | null;
  description: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

export function AgentsClient() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentsRes, deptsRes] = await Promise.all([
        fetchWithTenant("/api/agents"),
        fetchWithTenant("/api/departments"),
      ]);
      if (!agentsRes.ok) throw new Error(`Agents: HTTP ${agentsRes.status}`);
      setAgents(await agentsRes.json());
      if (deptsRes.ok) setDepartments(await deptsRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load agents");
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

  const deptName = (id: string | null) =>
    departments.find((d) => d.id === id)?.name ?? id ?? "—";

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Agents</h1>
        <Link
          href="/agents/new"
          className="inline-flex items-center px-3 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          + New Agent
        </Link>
      </div>

      {error ? (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : agents.length === 0 ? (
        <p className="text-sm text-gray-400">No agents found.</p>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Department
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Last Heartbeat
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {agents.map((agent) => (
                <tr key={agent.id} className="hover:bg-gray-50 transition-colors cursor-pointer">
                  <td className="px-4 py-3">
                    <Link href={`/agents/${agent.id}`} className="block">
                      <div className="font-medium text-gray-900 hover:text-brand-600">{agent.name}</div>
                      {agent.description && (
                        <div className="text-xs text-gray-400 truncate max-w-xs">
                          {agent.description}
                        </div>
                      )}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{agent.type}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {agent.departmentId ? (
                      deptName(agent.departmentId)
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <AgentStatusBadge status={agent.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {agent.lastHeartbeatAt ? (
                      new Date(agent.lastHeartbeatAt).toLocaleString()
                    ) : (
                      <span className="text-gray-300">Never</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/agents/${agent.id}/test`}
                      className="px-3 py-1 text-xs bg-brand-600 hover:bg-brand-700 text-white rounded-md font-medium"
                    >
                      ▶ Chat
                    </Link>
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

function AgentStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-600",
    testing: "bg-blue-100 text-blue-700",
    active: "bg-green-100 text-green-700",
    degraded: "bg-yellow-100 text-yellow-700",
    paused: "bg-orange-100 text-orange-700",
    stopped: "bg-gray-100 text-gray-500",
    error: "bg-red-100 text-red-700",
    archived: "bg-gray-100 text-gray-400",
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
