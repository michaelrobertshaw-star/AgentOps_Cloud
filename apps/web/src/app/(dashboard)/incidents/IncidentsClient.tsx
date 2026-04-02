"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

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
  incidentId?: string | null;
  attachmentsRef?: string[] | null;
}

interface IncidentPage {
  data: Incident[];
  total: number;
  page: number;
  limit: number;
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

// Which button to show and what status it transitions to
const STATUS_ACTIONS: Record<string, { label: string; next: string; color: string } | null> = {
  open: { label: "Investigate", next: "investigating", color: "bg-yellow-100 text-yellow-800 hover:bg-yellow-200" },
  investigating: { label: "Resolve", next: "resolved", color: "bg-green-100 text-green-800 hover:bg-green-200" },
  mitigated: { label: "Resolve", next: "resolved", color: "bg-green-100 text-green-800 hover:bg-green-200" },
  resolved: null,
  closed: null,
};

interface FormState {
  title: string;
  description: string;
  severity: string;
  departmentId: string;
  attachmentKeys: string[];
}

const EMPTY_FORM: FormState = {
  title: "",
  description: "",
  severity: "medium",
  departmentId: "",
  attachmentKeys: [],
};

export function IncidentsClient() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [createdIncidentId, setCreatedIncidentId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const deptsRes = await fetchWithTenant("/api/departments");
      if (!deptsRes.ok) throw new Error(`Departments: HTTP ${deptsRes.status}`);
      const depts: Department[] = await deptsRes.json();
      setDepartments(depts);

      const activeDepts = depts.filter((d) => d.status === "active");
      const results = await Promise.all(
        activeDepts.map(async (dept) => {
          const res = await fetchWithTenant(`/api/departments/${dept.id}/incidents?limit=100`);
          if (!res.ok) return [];
          const page: IncidentPage = await res.json();
          return page.data.map((i) => ({ ...i, departmentName: dept.name }));
        }),
      );

      const all = results
        .flat()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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

  function closeModal() {
    setShowModal(false);
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreatedIncidentId(null);
  }

  async function handleFileUpload(file: File) {
    setUploadingFile(true);
    try {
      const params = new URLSearchParams({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
      });
      const signedRes = await fetchWithTenant(`/api/uploads/signed-url?${params}`);
      if (!signedRes.ok) throw new Error("Failed to get upload URL");
      const { url, key } = await signedRes.json() as { url: string; key: string };

      // Upload directly to MinIO/S3
      const uploadRes = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Upload failed");

      setForm((f) => ({ ...f, attachmentKeys: [...f.attachmentKeys, key] }));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "File upload failed");
    } finally {
      setUploadingFile(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetchWithTenant(`/api/departments/${form.departmentId}/incidents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          description: form.description,
          severity: form.severity,
          attachment_keys: form.attachmentKeys.length > 0 ? form.attachmentKeys : undefined,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const created = await res.json() as { incidentId?: string };
      setCreatedIncidentId(created.incidentId ?? null);
      setForm(EMPTY_FORM);
      await fetchAll();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to create incident");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTransition(incidentId: string, nextStatus: string) {
    setTransitioningId(incidentId);
    try {
      const res = await fetchWithTenant(`/api/incidents/${incidentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        console.error("Transition failed:", (b as { error?: string }).error);
      }
      await fetchAll();
    } finally {
      setTransitioningId(null);
    }
  }

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
        <div className="flex items-center gap-3">
          <button
            onClick={fetchAll}
            className="text-sm text-brand-600 hover:text-brand-700 font-medium"
          >
            Refresh
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="inline-flex items-center px-3 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            + New Incident
          </button>
        </div>
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
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {incidents.map((inc) => {
                const action = STATUS_ACTIONS[inc.status] ?? null;
                return (
                  <tr key={inc.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{inc.title}</div>
                      {inc.incidentId && (
                        <div className="text-xs font-mono text-brand-600 font-semibold mt-0.5">
                          {inc.incidentId}
                        </div>
                      )}
                      <div className="text-xs text-gray-400 truncate max-w-xs">
                        {inc.description}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <SeverityBadge severity={inc.severity} />
                    </td>
                    <td className="px-4 py-3">
                      <IncidentStatusBadge status={inc.status} />
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {inc.departmentName ?? inc.departmentId}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {new Date(inc.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      {action && (
                        <button
                          onClick={() => handleTransition(inc.id, action.next)}
                          disabled={transitioningId === inc.id}
                          className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 ${action.color}`}
                        >
                          {transitioningId === inc.id ? "..." : action.label}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">New Incident</h2>

            {createdIncidentId && (
              <div className="mb-4 rounded-lg bg-green-50 border border-green-200 px-4 py-3">
                <p className="text-sm font-semibold text-green-800">Incident Created</p>
                <p className="text-lg font-bold text-green-700 mt-1">{createdIncidentId}</p>
                <button
                  type="button"
                  onClick={closeModal}
                  className="mt-2 px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg"
                >
                  Close
                </button>
              </div>
            )}

            {!createdIncidentId && (
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Title <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description <span className="text-red-500">*</span>
                </label>
                <textarea
                  required
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Severity <span className="text-red-500">*</span>
                </label>
                <select
                  value={form.severity}
                  onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Department <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  value={form.departmentId}
                  onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="">Select department</option>
                  {departments
                    .filter((d) => d.status === "active")
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
              </div>
              {/* File upload */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Attachments (optional)
                </label>
                <div
                  className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center cursor-pointer hover:border-brand-400 transition-colors"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files[0];
                    if (file) handleFileUpload(file);
                  }}
                  onClick={() => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.onchange = (ev) => {
                      const file = (ev.target as HTMLInputElement).files?.[0];
                      if (file) handleFileUpload(file);
                    };
                    input.click();
                  }}
                >
                  {uploadingFile ? (
                    <p className="text-sm text-gray-400">Uploading...</p>
                  ) : (
                    <p className="text-sm text-gray-400">
                      Drag & drop a file, or click to select
                    </p>
                  )}
                </div>
                {form.attachmentKeys.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {form.attachmentKeys.map((key, i) => (
                      <li key={i} className="flex items-center justify-between text-xs text-gray-600 bg-gray-50 rounded px-2 py-1">
                        <span className="truncate">{key.split("/").pop()}</span>
                        <button
                          type="button"
                          onClick={() => setForm((f) => ({
                            ...f,
                            attachmentKeys: f.attachmentKeys.filter((_, idx) => idx !== i),
                          }))}
                          className="ml-2 text-red-400 hover:text-red-600"
                        >
                          x
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {formError && (
                <div className="rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                  {formError}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || uploadingFile}
                  className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
                >
                  {submitting ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
            )}
          </div>
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
