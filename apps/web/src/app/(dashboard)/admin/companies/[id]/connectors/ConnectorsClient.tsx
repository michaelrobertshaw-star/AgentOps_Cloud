"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

const CONNECTOR_TYPES = ["claude_api", "claude_browser", "webhook", "http_get", "minio_storage"] as const;
type ConnectorType = (typeof CONNECTOR_TYPES)[number];

/** Secret field keys expected per connector type */
const SECRET_FIELDS: Record<ConnectorType, string[]> = {
  claude_api: ["api_key"],
  claude_browser: ["api_key"],
  webhook: ["secret"],
  http_get: ["api_key"],
  minio_storage: ["access_key", "secret_key"],
};

/** Config field keys expected per connector type */
const CONFIG_FIELDS: Record<ConnectorType, string[]> = {
  claude_api: ["model"],
  claude_browser: ["model"],
  webhook: ["url"],
  http_get: ["url"],
  minio_storage: ["endpoint", "bucket"],
};

interface Connector {
  id: string;
  type: ConnectorType;
  name: string;
  description: string | null;
  isDefault: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface FormState {
  type: ConnectorType;
  name: string;
  description: string;
  isDefault: boolean;
  config: Record<string, string>;
  secrets: Record<string, string>;
}

const EMPTY_FORM: FormState = {
  type: "claude_api",
  name: "",
  description: "",
  isDefault: false,
  config: {},
  secrets: {},
};

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    claude_api: "bg-purple-100 text-purple-700",
    claude_browser: "bg-indigo-100 text-indigo-700",
    webhook: "bg-blue-100 text-blue-700",
    http_get: "bg-green-100 text-green-700",
    minio_storage: "bg-orange-100 text-orange-700",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${colors[type] ?? "bg-gray-100 text-gray-600"}`}>
      {type}
    </span>
  );
}

function ConnectorForm({
  initial,
  onSubmit,
  onCancel,
  submitting,
  error,
}: {
  initial: FormState;
  onSubmit: (form: FormState) => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
}) {
  const [form, setForm] = useState<FormState>(initial);

  // When type changes, reset config/secrets to the expected fields
  function handleTypeChange(type: ConnectorType) {
    const config: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    CONFIG_FIELDS[type].forEach((k) => { config[k] = ""; });
    SECRET_FIELDS[type].forEach((k) => { secrets[k] = ""; });
    setForm((f) => ({ ...f, type, config, secrets }));
  }

  // Init config/secrets when mounting with existing connector (edit mode)
  useEffect(() => {
    const config: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    CONFIG_FIELDS[form.type].forEach((k) => { config[k] = String((initial.config as Record<string, unknown>)[k] ?? ""); });
    SECRET_FIELDS[form.type].forEach((k) => { secrets[k] = String(initial.secrets[k] ?? ""); });
    setForm((f) => ({ ...f, config, secrets }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Type *</label>
          <select
            value={form.type}
            onChange={(e) => handleTypeChange(e.target.value as ConnectorType)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            {CONNECTOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
          <input
            required
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
        <input
          type="text"
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {/* Config fields */}
      {CONFIG_FIELDS[form.type].length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Config</p>
          <div className="space-y-2">
            {CONFIG_FIELDS[form.type].map((key) => (
              <div key={key}>
                <label className="block text-xs text-gray-600 mb-0.5">{key}</label>
                <input
                  type="text"
                  value={String(form.config[key] ?? "")}
                  onChange={(e) => setForm((f) => ({ ...f, config: { ...f.config, [key]: e.target.value } }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Secret fields */}
      {SECRET_FIELDS[form.type].length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Secrets <span className="text-gray-400 normal-case font-normal">(leave blank to keep existing)</span></p>
          <div className="space-y-2">
            {SECRET_FIELDS[form.type].map((key) => (
              <div key={key}>
                <label className="block text-xs text-gray-600 mb-0.5">{key}</label>
                <input
                  type="password"
                  placeholder={form.secrets[key] ?? ""}
                  value={form.secrets[key] ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, secrets: { ...f.secrets, [key]: e.target.value } }))}
                  autoComplete="off"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          id="isDefault"
          type="checkbox"
          checked={form.isDefault}
          onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
          className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
        />
        <label htmlFor="isDefault" className="text-sm text-gray-700">Default connector for this type</label>
      </div>

      {error && (
        <div className="rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
        >
          {submitting ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}

export function ConnectorsClient({ companyId }: { companyId: string }) {
  const [connectorList, setConnectorList] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create / edit modal
  const [showForm, setShowForm] = useState(false);
  const [editingConnector, setEditingConnector] = useState<Connector | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchConnectors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/companies/${companyId}/connectors`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConnectorList(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load connectors");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    fetchConnectors();
  }, [fetchConnectors]);

  async function handleCreate(form: FormState) {
    setSubmitting(true);
    setFormError(null);
    try {
      // Only send non-empty secrets
      const secrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(form.secrets)) {
        if (v.trim()) secrets[k] = v;
      }
      const config: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form.config)) {
        if (v.trim()) config[k] = v;
      }

      const res = await fetch(`/api/admin/companies/${companyId}/connectors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: form.type, name: form.name, description: form.description || undefined, config, secrets, isDefault: form.isDefault }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setShowForm(false);
      await fetchConnectors();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to create connector");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEdit(form: FormState) {
    if (!editingConnector) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const secrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(form.secrets)) {
        if (v.trim()) secrets[k] = v;
      }
      const config: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form.config)) {
        if (v.trim()) config[k] = v;
      }

      const body: Record<string, unknown> = { name: form.name, description: form.description || undefined, config, isDefault: form.isDefault };
      if (Object.keys(secrets).length > 0) body.secrets = secrets;

      const res = await fetch(`/api/admin/companies/${companyId}/connectors/${editingConnector.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setEditingConnector(null);
      await fetchConnectors();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to update connector");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/admin/companies/${companyId}/connectors/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setDeletingId(null);
      await fetchConnectors();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete connector");
    }
  }

  function startEdit(connector: Connector) {
    setFormError(null);
    setEditingConnector(connector);
  }

  const editInitial: FormState = editingConnector
    ? {
        type: editingConnector.type,
        name: editingConnector.name,
        description: editingConnector.description ?? "",
        isDefault: editingConnector.isDefault,
        config: Object.fromEntries(
          CONFIG_FIELDS[editingConnector.type].map((k) => [k, String((editingConnector.config as Record<string, unknown>)[k] ?? "")]),
        ),
        secrets: Object.fromEntries(
          SECRET_FIELDS[editingConnector.type].map((k) => [k, editingConnector.secrets[k] ?? ""]),
        ),
      }
    : EMPTY_FORM;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-sm text-gray-400">
        <Link href="/admin/companies" className="hover:text-gray-600">Companies</Link>
        <span>›</span>
        <Link href={`/admin/companies/${companyId}`} className="hover:text-gray-600">Detail</Link>
        <span>›</span>
        <span className="text-gray-700">Connectors</span>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Connectors</h1>
          <p className="text-sm text-gray-500 mt-1">Manage connector instances for this company</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setFormError(null); }}
          className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg"
        >
          + New Connector
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Connector list */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-400 animate-pulse">Loading...</div>
        ) : connectorList.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No connectors yet. Click &ldquo;+ New Connector&rdquo; to add one.</div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Config</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Secrets</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Default</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {connectorList.map((connector) => (
                <tr key={connector.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{connector.name}</p>
                    {connector.description && <p className="text-xs text-gray-400 mt-0.5">{connector.description}</p>}
                  </td>
                  <td className="px-4 py-3"><TypeBadge type={connector.type} /></td>
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                    {Object.entries(connector.config ?? {}).map(([k, v]) => (
                      <div key={k}><span className="text-gray-400">{k}:</span> {String(v)}</div>
                    ))}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                    {Object.entries(connector.secrets ?? {}).map(([k, v]) => (
                      <div key={k}><span className="text-gray-400">{k}:</span> {v}</div>
                    ))}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {connector.isDefault && <span className="text-green-600 text-xs font-semibold">✓</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={() => startEdit(connector)}
                        className="text-xs text-brand-600 hover:text-brand-800 font-medium"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setDeletingId(connector.id)}
                        className="text-xs text-red-500 hover:text-red-700 font-medium"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">New Connector</h2>
            <ConnectorForm
              initial={EMPTY_FORM}
              onSubmit={handleCreate}
              onCancel={() => setShowForm(false)}
              submitting={submitting}
              error={formError}
            />
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editingConnector && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Edit Connector</h2>
            <ConnectorForm
              initial={editInitial}
              onSubmit={handleEdit}
              onCancel={() => setEditingConnector(null)}
              submitting={submitting}
              error={formError}
            />
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deletingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Delete Connector</h2>
            <p className="text-sm text-gray-600 mb-4">Are you sure? This cannot be undone. Agents using this connector will lose access.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeletingId(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deletingId)}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
