"use client";

import { useEffect, useState, useCallback } from "react";

interface Agent {
  id: string;
  name: string;
  type: string;
  version: string | null;
  status: string;
  description: string | null;
  deployedAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

function AgentStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-600",
    testing: "bg-yellow-100 text-yellow-700",
    tested: "bg-blue-100 text-blue-700",
    deployed: "bg-green-100 text-green-700",
    disabled: "bg-red-100 text-red-700",
    active: "bg-green-100 text-green-700",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
        map[status] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {status}
    </span>
  );
}

export function AgentDetailClient({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchAgent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Agent;
      setAgent(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load agent");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchAgent();
  }, [fetchAgent]);

  async function handleDeploy() {
    setActionLoading(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/deploy`, { method: "POST" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await fetchAgent();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Deploy failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUndeploy() {
    setActionLoading(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/undeploy`, { method: "POST" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await fetchAgent();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Undeploy failed");
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-200 rounded-xl" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
        {error ?? "Agent not found"}
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-1">
        <a href="/agents" className="text-sm text-gray-400 hover:text-gray-600">
          &larr; Back to Agents
        </a>
      </div>

      <div className="flex items-center justify-between mb-6 mt-3">
        <h1 className="text-2xl font-bold text-gray-900">{agent.name}</h1>
        <div className="flex items-center gap-2">
          <AgentStatusBadge status={agent.status} />
          {agent.status === "tested" && (
            <button
              onClick={handleDeploy}
              disabled={actionLoading}
              className="inline-flex items-center px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
            >
              {actionLoading ? "Deploying..." : "Deploy"}
            </button>
          )}
          {agent.status === "deployed" && (
            <button
              onClick={handleUndeploy}
              disabled={actionLoading}
              className="inline-flex items-center px-3 py-1.5 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
            >
              {actionLoading ? "Undeploying..." : "Undeploy"}
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-4">
          {actionError}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Type</p>
            <p className="mt-0.5 font-medium text-gray-800">{agent.type}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Version</p>
            <p className="mt-0.5 font-medium text-gray-800">
              {agent.version ?? <span className="text-gray-300">—</span>}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Status</p>
            <div className="mt-1">
              <AgentStatusBadge status={agent.status} />
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Created</p>
            <p className="mt-0.5 font-medium text-gray-800">
              {new Date(agent.createdAt).toLocaleString()}
            </p>
          </div>
        </div>

        {agent.description && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Description</p>
            <p className="mt-0.5 text-sm text-gray-700">{agent.description}</p>
          </div>
        )}

        {agent.deployedAt && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Deployed At</p>
            <p className="mt-0.5 text-sm font-medium text-gray-800">
              {new Date(agent.deployedAt).toLocaleString()}
            </p>
          </div>
        )}

        {agent.lastHeartbeatAt && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Last Heartbeat</p>
            <p className="mt-0.5 text-sm font-medium text-gray-800">
              {new Date(agent.lastHeartbeatAt).toLocaleString()}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
