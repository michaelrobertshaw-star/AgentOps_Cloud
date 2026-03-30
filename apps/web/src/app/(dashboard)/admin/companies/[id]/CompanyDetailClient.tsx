"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

interface Company {
  id: string;
  name: string;
  displayName: string;
  status: string;
  timezone: string;
  region: string | null;
  billingPlan: string | null;
  createdAt: string;
  companySettings: Record<string, unknown>;
}

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
}

interface AgentUsageRow {
  agentId: string;
  agentName: string | null;
  runCount: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  avgDurationMs: number;
}

interface UsageSummary {
  totalRuns: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCostUsd: number;
  spendCapUsd: number | null;
}

interface InviteForm {
  email: string;
  name: string;
  role: string;
  password: string;
}

const EMPTY_INVITE: InviteForm = { email: "", name: "", role: "company_admin", password: "" };

export function CompanyDetailClient({ companyId }: { companyId: string }) {
  const [company, setCompany] = useState<Company | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"users" | "settings" | "usage">("users");
  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState<InviteForm>(EMPTY_INVITE);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Usage state
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [agentUsage, setAgentUsage] = useState<AgentUsageRow[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [companyRes, usersRes] = await Promise.all([
        fetch(`/api/admin/companies/${companyId}`),
        fetch(`/api/admin/companies/${companyId}/users`),
      ]);
      if (!companyRes.ok) throw new Error(`HTTP ${companyRes.status}`);
      setCompany(await companyRes.json());
      if (usersRes.ok) setUsers(await usersRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load company");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  const fetchUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const monthStart = new Date();
      monthStart.setDate(1);
      const from = monthStart.toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const params = new URLSearchParams({ from, to });

      const [summaryRes, byAgentRes] = await Promise.all([
        fetch(`/api/usage/summary?${params}`),
        fetch(`/api/usage/by-agent?${params}`),
      ]);

      if (summaryRes.ok) setUsageSummary(await summaryRes.json());
      if (byAgentRes.ok) setAgentUsage(await byAgentRes.json());
    } finally {
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (activeTab === "usage") {
      fetchUsage();
    }
  }, [activeTab, fetchUsage]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/companies/${companyId}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invite),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setShowInvite(false);
      setInvite(EMPTY_INVITE);
      await fetchData();
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : "Failed to invite user");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 w-64 bg-gray-200 rounded" />
        <div className="h-48 bg-gray-200 rounded-xl" />
      </div>
    );
  }

  if (error || !company) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
        {error ?? "Company not found"}
      </div>
    );
  }

  const spendCap = company.companySettings?.spend_cap_usd as number | undefined;

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <Link href="/admin/companies" className="text-sm text-gray-400 hover:text-gray-600">
          ← Companies
        </Link>
      </div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{company.displayName}</h1>
          <p className="text-sm text-gray-400 font-mono">{company.name}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-semibold ${
            company.status === "active" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
          }`}>
            {company.status}
          </span>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Users</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{users.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Spend Cap</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">
            {spendCap ? `$${spendCap.toFixed(2)}/mo` : "No cap"}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Plan</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{company.billingPlan ?? "free"}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 mb-4">
        {(["users", "usage", "settings"] as const).map((tab) => (
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

      {activeTab === "users" && (
        <div>
          <div className="flex justify-end mb-3">
            <button
              onClick={() => setShowInvite(true)}
              className="px-3 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg"
            >
              + Invite User
            </button>
          </div>

          {users.length === 0 ? (
            <p className="text-sm text-gray-400">No users yet.</p>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Role</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Last Login</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{user.name}</td>
                      <td className="px-4 py-3 text-gray-500">{user.email}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{user.role.replace("_", " ")}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                          user.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                        }`}>
                          {user.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "Never"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === "usage" && (
        <div>
          {usageLoading ? (
            <div className="p-8 text-center text-gray-400 animate-pulse">Loading usage...</div>
          ) : (
            <>
              {/* Spend cap warning banner */}
              {usageSummary && usageSummary.spendCapUsd && usageSummary.spendCapUsd > 0 && (() => {
                const pct = (usageSummary.totalCostUsd / usageSummary.spendCapUsd!) * 100;
                if (pct >= 100) {
                  return (
                    <div className="mb-4 rounded-lg bg-red-50 border border-red-300 px-4 py-3 flex items-center gap-3">
                      <span className="text-red-600 text-lg">⛔</span>
                      <div>
                        <p className="text-sm font-semibold text-red-700">Spend cap reached</p>
                        <p className="text-xs text-red-600">
                          ${usageSummary.totalCostUsd.toFixed(2)} of ${usageSummary.spendCapUsd!.toFixed(2)} monthly cap used ({pct.toFixed(0)}%).
                          New runs are blocked.
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
                        <p className="text-sm font-semibold text-yellow-700">Spend cap warning</p>
                        <p className="text-xs text-yellow-600">
                          ${usageSummary.totalCostUsd.toFixed(2)} of ${usageSummary.spendCapUsd!.toFixed(2)} monthly cap used ({pct.toFixed(0)}%).
                        </p>
                      </div>
                    </div>
                  );
                }
                return null;
              })()}

              {/* Monthly spend vs cap */}
              {usageSummary && (
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Monthly Spend</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1">${usageSummary.totalCostUsd.toFixed(4)}</p>
                    {usageSummary.spendCapUsd && (
                      <div className="mt-2">
                        <div className="flex justify-between text-xs text-gray-400 mb-1">
                          <span>of ${usageSummary.spendCapUsd.toFixed(2)} cap</span>
                          <span>{((usageSummary.totalCostUsd / usageSummary.spendCapUsd) * 100).toFixed(0)}%</span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${
                              (usageSummary.totalCostUsd / usageSummary.spendCapUsd) >= 1
                                ? "bg-red-500"
                                : (usageSummary.totalCostUsd / usageSummary.spendCapUsd) >= 0.8
                                ? "bg-yellow-400"
                                : "bg-brand-500"
                            }`}
                            style={{ width: `${Math.min((usageSummary.totalCostUsd / usageSummary.spendCapUsd) * 100, 100)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Total Runs (this month)</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1">{usageSummary.totalRuns.toLocaleString()}</p>
                  </div>
                </div>
              )}

              {/* Per-agent breakdown */}
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                <div className="px-4 py-3 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-700">Usage by Agent (this month)</h3>
                </div>
                {agentUsage.length === 0 ? (
                  <div className="p-8 text-center text-gray-400 text-sm">No runs this month.</div>
                ) : (
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Agent</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Runs</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Input Tokens</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Output Tokens</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Cost (USD)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {agentUsage.map((row) => (
                        <tr key={row.agentId} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium text-gray-900">{row.agentName ?? row.agentId.slice(0, 8)}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{row.runCount.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{row.tokensInput.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{row.tokensOutput.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right font-mono text-gray-900">${row.costUsd.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "settings" && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Company Settings</h3>
          {Object.keys(company.companySettings).length === 0 ? (
            <p className="text-sm text-gray-400">No settings configured.</p>
          ) : (
            <dl className="space-y-2">
              {Object.entries(company.companySettings).map(([key, value]) => (
                <div key={key} className="flex gap-4">
                  <dt className="text-sm font-mono text-gray-500 w-48 shrink-0">{key}</dt>
                  <dd className="text-sm text-gray-900">{JSON.stringify(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      {/* Invite modal */}
      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Invite User</h2>
            <form onSubmit={handleInvite} className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                <input type="email" required value={invite.email} onChange={(e) => setInvite((f) => ({ ...f, email: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
                <input type="text" required value={invite.name} onChange={(e) => setInvite((f) => ({ ...f, name: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select value={invite.role} onChange={(e) => setInvite((f) => ({ ...f, role: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                  <option value="company_admin">Company Admin</option>
                  <option value="technical_admin">Technical Admin</option>
                  <option value="auditor">Auditor</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password *</label>
                <input type="password" required minLength={8} value={invite.password} onChange={(e) => setInvite((f) => ({ ...f, password: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              {inviteError && (
                <div className="rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{inviteError}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowInvite(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
                <button type="submit" disabled={submitting} className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50">
                  {submitting ? "Inviting..." : "Invite"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
