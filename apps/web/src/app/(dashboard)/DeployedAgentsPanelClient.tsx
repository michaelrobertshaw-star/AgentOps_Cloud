"use client";

import { useEffect, useState } from "react";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

interface Agent {
  id: string;
  name: string;
  type: string;
  deployedAt: string | null;
}

export function DeployedAgentsPanelClient() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchDeployed() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchWithTenant("/api/agents?status=deployed");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Agent[];
        setAgents(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load deployed agents");
      } finally {
        setLoading(false);
      }
    }
    fetchDeployed();
  }, []);

  if (loading) {
    return (
      <div className="space-y-2 animate-pulse">
        <div className="h-5 w-32 bg-gray-200 rounded" />
        <div className="h-20 bg-gray-200 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {agents.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-400">No agents deployed yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {agents.map((agent) => (
            <li key={agent.id}>
              <a
                href={`/agents/${agent.id}`}
                className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">{agent.name}</p>
                  <p className="text-xs text-gray-400">{agent.type}</p>
                </div>
                <div className="text-right">
                  {agent.deployedAt ? (
                    <p className="text-xs text-gray-400">
                      Deployed {new Date(agent.deployedAt).toLocaleDateString()}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-300">—</p>
                  )}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
