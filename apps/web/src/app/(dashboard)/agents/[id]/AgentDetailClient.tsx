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

interface AgentSkill {
  id: string;
  name: string;
  description: string | null;
  urlKey: string;
}

interface AgentUsageSummary {
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

/** Minimal SVG sparkline chart */
function SparklineChart({ data, width = 400, height = 80 }: { data: DailyPoint[]; width?: number; height?: number }) {
  if (data.length === 0) {
    return <div className="h-20 flex items-center justify-center text-xs text-gray-300">No data</div>;
  }
  const maxCost = Math.max(...data.map((d) => d.costUsd), 0.0001);
  const pts = data.map((d, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * (width - 20) + 10;
    const y = height - 10 - ((d.costUsd / maxCost) * (height - 20));
    return `${x},${y}`;
  });
  const polyline = pts.join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <polyline points={polyline} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinejoin="round" />
      {data.map((d, i) => {
        const [x, y] = pts[i].split(",").map(Number);
        return (
          <circle key={i} cx={x} cy={y} r="3" fill="#6366f1">
            <title>{`${d.date}: $${d.costUsd.toFixed(4)} (${d.runCount} runs)`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

export function AgentDetailClient({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"details" | "usage" | "skills">("details");

  // Skills state
  const [assignedSkills, setAssignedSkills] = useState<AgentSkill[]>([]);
  const [companySkills, setCompanySkills] = useState<AgentSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [skillActionLoading, setSkillActionLoading] = useState(false);

  // Usage state
  const [usageSummary, setUsageSummary] = useState<AgentUsageSummary | null>(null);
  const [dailyData, setDailyData] = useState<DailyPoint[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);

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

  const fetchSkills = useCallback(async () => {
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const [assignedRes, companyRes] = await Promise.all([
        fetch(`/api/agents/${agentId}/skills`),
        fetch(`/api/skills`),
      ]);
      if (assignedRes.ok) setAssignedSkills(await assignedRes.json());
      if (companyRes.ok) setCompanySkills(await companyRes.json());
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : "Failed to load skills");
    } finally {
      setSkillsLoading(false);
    }
  }, [agentId]);

  async function handleAddSkill() {
    if (!selectedSkillId) return;
    setSkillActionLoading(true);
    setSkillsError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: selectedSkillId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setSelectedSkillId("");
      await fetchSkills();
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : "Failed to add skill");
    } finally {
      setSkillActionLoading(false);
    }
  }

  async function handleRemoveSkill(skillId: string) {
    setSkillActionLoading(true);
    setSkillsError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/skills/${skillId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await fetchSkills();
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : "Failed to remove skill");
    } finally {
      setSkillActionLoading(false);
    }
  }

  const fetchUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const monthStart = new Date();
      monthStart.setDate(1);
      const from = monthStart.toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const params = new URLSearchParams({ from, to, agentId });

      const [byAgentRes, dailyRes] = await Promise.all([
        fetch(`/api/usage/by-agent?${params}`),
        fetch(`/api/usage/daily?${params}`),
      ]);

      if (byAgentRes.ok) {
        const rows = await byAgentRes.json() as Array<{
          agentId: string;
          runCount: number;
          tokensInput: number;
          tokensOutput: number;
          costUsd: number;
          avgDurationMs: number;
        }>;
        const row = rows.find((r) => r.agentId === agentId);
        if (row) {
          setUsageSummary({
            runCount: row.runCount,
            tokensInput: row.tokensInput,
            tokensOutput: row.tokensOutput,
            costUsd: row.costUsd,
            avgDurationMs: row.avgDurationMs,
          });
        } else {
          setUsageSummary({ runCount: 0, tokensInput: 0, tokensOutput: 0, costUsd: 0, avgDurationMs: 0 });
        }
      }

      if (dailyRes.ok) {
        setDailyData(await dailyRes.json());
      }
    } finally {
      setUsageLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchAgent();
  }, [fetchAgent]);

  useEffect(() => {
    if (activeTab === "usage") fetchUsage();
    if (activeTab === "skills") fetchSkills();
  }, [activeTab, fetchUsage, fetchSkills]);

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

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 mb-4">
        {(["details", "usage", "skills"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`pb-2 text-sm font-medium capitalize border-b-2 transition-colors ${
              activeTab === tab
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "details" && (
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
      )}

      {activeTab === "skills" && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          {skillsError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {skillsError}
            </div>
          )}

          {/* Add skill */}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Add Skill</p>
            <div className="flex gap-2">
              <select
                value={selectedSkillId}
                onChange={(e) => setSelectedSkillId(e.target.value)}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                disabled={skillActionLoading || skillsLoading}
              >
                <option value="">— select a skill —</option>
                {companySkills
                  .filter((s) => !assignedSkills.some((a) => a.id === s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <button
                onClick={handleAddSkill}
                disabled={!selectedSkillId || skillActionLoading}
                className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                Add
              </button>
            </div>
          </div>

          {/* Assigned skills list */}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Assigned Skills</p>
            {skillsLoading ? (
              <div className="py-4 text-center text-sm text-gray-400 animate-pulse">Loading…</div>
            ) : assignedSkills.length === 0 ? (
              <p className="text-sm text-gray-400">No skills assigned.</p>
            ) : (
              <ul className="space-y-2">
                {assignedSkills.map((skill) => (
                  <li
                    key={skill.id}
                    className="flex items-center justify-between rounded-lg border border-gray-100 px-4 py-2.5"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">{skill.name}</p>
                      {skill.description && (
                        <p className="text-xs text-gray-400 mt-0.5">{skill.description}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleRemoveSkill(skill.id)}
                      disabled={skillActionLoading}
                      className="ml-4 text-xs text-red-500 hover:text-red-700 disabled:opacity-50 transition-colors"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {activeTab === "usage" && (
        <div>
          {usageLoading ? (
            <div className="p-8 text-center text-gray-400 animate-pulse">Loading usage...</div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Cost to Date (this month)</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    ${(usageSummary?.costUsd ?? 0).toFixed(4)}
                  </p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Total Runs</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    {(usageSummary?.runCount ?? 0).toLocaleString()}
                  </p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Avg Cost per Run</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    ${usageSummary && usageSummary.runCount > 0
                      ? (usageSummary.costUsd / usageSummary.runCount).toFixed(4)
                      : "0.0000"}
                  </p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Avg Duration</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    {usageSummary && usageSummary.avgDurationMs > 0
                      ? `${(usageSummary.avgDurationMs / 1000).toFixed(1)}s`
                      : "—"}
                  </p>
                </div>
              </div>

              {/* Daily cost chart */}
              <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                <p className="text-sm font-semibold text-gray-700 mb-3">Daily Cost (this month)</p>
                {dailyData.length > 0 ? (
                  <>
                    <SparklineChart data={dailyData} />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>{dailyData[0]?.date}</span>
                      <span>{dailyData[dailyData.length - 1]?.date}</span>
                    </div>
                  </>
                ) : (
                  <div className="py-8 text-center text-sm text-gray-400">No runs this month</div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
