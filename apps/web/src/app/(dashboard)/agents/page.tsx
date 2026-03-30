import { requireSession } from "@/lib/auth";
import { apiFetch } from "@/lib/api";

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

export default async function AgentsPage() {
  await requireSession();

  let agents: Agent[] = [];
  let error: string | null = null;
  try {
    agents = await apiFetch<Agent[]>("/api/agents");
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load agents";
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Agents</h1>
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
                  Version
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Last Heartbeat
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {agents.map((agent) => (
                <tr key={agent.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{agent.name}</div>
                    {agent.description && (
                      <div className="text-xs text-gray-400 truncate max-w-xs">{agent.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{agent.type}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {agent.version ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <AgentStatusBadge status={agent.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {agent.lastHeartbeatAt
                      ? new Date(agent.lastHeartbeatAt).toLocaleString()
                      : <span className="text-gray-300">Never</span>}
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
