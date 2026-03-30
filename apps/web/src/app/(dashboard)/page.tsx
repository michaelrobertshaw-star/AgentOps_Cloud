import { requireSession } from "@/lib/auth";
import { DeployedAgentsPanelClient } from "./DeployedAgentsPanelClient";

export default async function DashboardPage() {
  const session = await requireSession();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Overview</h1>
        <p className="text-sm text-gray-500 mt-1">
          Company&nbsp;
          <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">{session.company_id}</code>
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {PLACEHOLDER_STATS.map((stat) => (
          <div
            key={stat.label}
            className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm"
          >
            <p className="text-sm font-medium text-gray-500">{stat.label}</p>
            <p className="text-3xl font-bold text-gray-900 mt-1">{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Deployed Agents</h2>
        <DeployedAgentsPanelClient />
      </div>
    </div>
  );
}

const PLACEHOLDER_STATS = [
  { label: "Departments", value: "—" },
  { label: "Active Agents", value: "—" },
  { label: "Tasks (24 h)", value: "—" },
  { label: "Incidents Open", value: "—" },
];
