"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Step = 1 | 2 | 3;

interface Step1Data {
  name: string;
  displayName: string;
  timezone: string;
  region: string;
}

interface Step2Data {
  spendCapUsd: string;
  brandColor: string;
  allowedConnectors: string[];
}

interface Step3Data {
  email: string;
  userName: string;
  role: string;
  password: string;
}

const TIMEZONES = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Tokyo", "Asia/Singapore"];

export function NewCompanyWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [step1, setStep1] = useState<Step1Data>({
    name: "",
    displayName: "",
    timezone: "UTC",
    region: "",
  });

  const [step2, setStep2] = useState<Step2Data>({
    spendCapUsd: "",
    brandColor: "",
    allowedConnectors: [],
  });

  const [step3, setStep3] = useState<Step3Data>({
    email: "",
    userName: "",
    role: "oneops_admin",
    password: "",
  });

  async function handleStep1(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: step1.name,
          displayName: step1.displayName,
          timezone: step1.timezone,
          region: step1.region || undefined,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const company = await res.json();
      setCreatedCompanyId(company.id);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create company");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStep2(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!createdCompanyId) throw new Error("Company not created yet");
      const settings: Record<string, unknown> = {};
      if (step2.spendCapUsd) settings.spend_cap_usd = parseFloat(step2.spendCapUsd);
      if (step2.brandColor) settings.brand_color = step2.brandColor;
      if (step2.allowedConnectors.length > 0) settings.allowed_connectors = step2.allowedConnectors;

      if (Object.keys(settings).length > 0) {
        const res = await fetch(`/api/admin/companies/${createdCompanyId}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
        }
      }
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStep3(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!createdCompanyId) throw new Error("Company not created yet");
      const res = await fetch(`/api/admin/companies/${createdCompanyId}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: step3.email,
          name: step3.userName,
          role: step3.role,
          password: step3.password,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      router.push(`/admin/companies/${createdCompanyId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to invite user");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">New Company</h1>
        <p className="text-sm text-gray-500 mt-1">Set up a new tenant in 3 steps</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {([1, 2, 3] as Step[]).map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
                step === s
                  ? "bg-brand-600 text-white"
                  : step > s
                  ? "bg-green-500 text-white"
                  : "bg-gray-200 text-gray-500"
              }`}
            >
              {step > s ? "✓" : s}
            </div>
            <span className="text-sm text-gray-600">
              {s === 1 ? "Name" : s === 2 ? "Settings" : "Invite User"}
            </span>
            {s < 3 && <div className="w-8 h-px bg-gray-200" />}
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        {error && (
          <div className="mb-4 rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {step === 1 && (
          <form onSubmit={handleStep1} className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">Step 1 — Company Identity</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Display Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="Acme Corp"
                value={step1.displayName}
                onChange={(e) => {
                  const v = e.target.value;
                  setStep1((s) => ({
                    ...s,
                    displayName: v,
                    name: s.name || v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
                  }));
                }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Slug <span className="text-red-500">*</span>
                <span className="ml-1 text-xs text-gray-400">(lowercase, hyphens only)</span>
              </label>
              <input
                type="text"
                required
                placeholder="acme-corp"
                pattern="[a-z0-9-]+"
                value={step1.name}
                onChange={(e) => setStep1((s) => ({ ...s, name: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
              <select
                value={step1.timezone}
                onChange={(e) => setStep1((s) => ({ ...s, timezone: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Region</label>
              <input
                type="text"
                placeholder="us-east-1"
                value={step1.region}
                onChange={(e) => setStep1((s) => ({ ...s, region: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
              >
                {submitting ? "Creating..." : "Next →"}
              </button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={handleStep2} className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">Step 2 — Settings</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Monthly Spend Cap (USD)
                <span className="ml-1 text-xs text-gray-400">— leave blank for no cap</span>
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="500.00"
                value={step2.spendCapUsd}
                onChange={(e) => setStep2((s) => ({ ...s, spendCapUsd: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Brand Color</label>
              <input
                type="text"
                placeholder="#6366f1"
                value={step2.brandColor}
                onChange={(e) => setStep2((s) => ({ ...s, brandColor: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Allowed Connectors</label>
              <div className="grid grid-cols-2 gap-2">
                {(["claude_api", "claude_browser", "webhook", "http_get", "minio_storage"] as const).map((type) => (
                  <label key={type} className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={step2.allowedConnectors.includes(type)}
                      onChange={(e) =>
                        setStep2((s) => ({
                          ...s,
                          allowedConnectors: e.target.checked
                            ? [...s.allowedConnectors, type]
                            : s.allowedConnectors.filter((c) => c !== type),
                        }))
                      }
                      className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="text-sm text-gray-700 font-mono">{type}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-between pt-2">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                ← Back
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
              >
                {submitting ? "Saving..." : "Next →"}
              </button>
            </div>
          </form>
        )}

        {step === 3 && (
          <form onSubmit={handleStep3} className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">Step 3 — Invite First User</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email <span className="text-red-500">*</span>
              </label>
              <input
                type="email"
                required
                placeholder="admin@company.com"
                value={step3.email}
                onChange={(e) => setStep3((s) => ({ ...s, email: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Full Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="Jane Smith"
                value={step3.userName}
                onChange={(e) => setStep3((s) => ({ ...s, userName: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
              <select
                value={step3.role}
                onChange={(e) => setStep3((s) => ({ ...s, role: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="oneops_admin">OneOps Admin</option>
                <option value="customer_admin">Customer Admin</option>
                <option value="customer_user">Customer User</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Temporary Password <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                required
                minLength={8}
                placeholder="Min 8 characters"
                value={step3.password}
                onChange={(e) => setStep3((s) => ({ ...s, password: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="flex justify-between pt-2">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                ← Back
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
              >
                {submitting ? "Creating..." : "Finish →"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
