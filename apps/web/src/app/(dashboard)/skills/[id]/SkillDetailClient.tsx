"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

interface AssignedAgent {
  id: string;
  name: string;
  status: string;
}

interface Skill {
  id: string;
  name: string;
  description: string | null;
  content: Record<string, unknown>;
  version: number;
  updatedAt: string;
  assignedAgents: AssignedAgent[];
}

export function SkillDetailClient({ skillId }: { skillId: string }) {
  const router = useRouter();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [yaml, setYaml] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchSkill = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills/${skillId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as Skill;
      setSkill(data);
      setName(data.name);
      setDescription(data.description ?? "");
      setYaml(typeof data.content?.yaml === "string" ? data.content.yaml : JSON.stringify(data.content, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load skill");
    } finally {
      setLoading(false);
    }
  }, [skillId]);

  useEffect(() => {
    fetchSkill();
  }, [fetchSkill]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaveSuccess(false);
    setSaving(true);
    try {
      const content = { yaml };
      const res = await fetch(`/api/skills/${skillId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description || undefined, content }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const updated = await res.json() as Skill;
      setSkill((s) => s ? { ...s, version: updated.version, updatedAt: updated.updatedAt } : s);
      setSaveSuccess(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this skill? This cannot be undone.")) return;
    try {
      await fetch(`/api/skills/${skillId}`, { method: "DELETE" });
      router.push("/skills");
    } catch {
      // ignore
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

  if (error || !skill) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
        {error ?? "Skill not found"}
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <a href="/skills" className="text-sm text-gray-400 hover:text-gray-600">← Skills</a>
      </div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{skill.name}</h1>
          <p className="text-xs text-gray-400">v{skill.version} · Updated {new Date(skill.updatedAt).toLocaleDateString()}</p>
        </div>
        <button
          onClick={handleDelete}
          className="px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          Delete
        </button>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">Skill Definition (YAML)</label>
          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            rows={18}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 resize-y"
          />
        </div>

        {skill.assignedAgents.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Assigned to Agents</h3>
            <div className="space-y-2">
              {skill.assignedAgents.map((agent) => (
                <div key={agent.id} className="flex items-center justify-between">
                  <span className="text-sm text-gray-900">{agent.name}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                    agent.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                  }`}>
                    {agent.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {saveError && (
          <div className="rounded bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{saveError}</div>
        )}
        {saveSuccess && (
          <div className="rounded bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">Saved successfully (v{skill.version})</div>
        )}

        <div className="flex justify-end gap-3">
          <a href="/skills" className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</a>
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
