"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

interface AgentTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tier: string;
  layerConfig: {
    infrastructure?: string;
    model?: string;
    data?: string[];
    orchestration?: string[];
    application?: string;
  };
  defaultAgentConfig: Record<string, unknown>;
}

interface Department {
  id: string;
  name: string;
  status: string;
}

type Step = 1 | 2 | 3 | 4;

const STEP_LABELS = ["Template", "Identity", "Configuration", "Review"];

const TIER_ICONS: Record<string, string> = {
  simple: "S",
  rag: "R",
  autonomous: "A",
  enterprise: "E",
};

const TIER_COLORS: Record<string, string> = {
  simple: "border-gray-200 bg-gray-50",
  rag: "border-blue-200 bg-blue-50",
  autonomous: "border-purple-200 bg-purple-50",
  enterprise: "border-amber-200 bg-amber-50",
};

export function AgentCreationWizard() {
  const router = useRouter();

  // Wizard state
  const [step, setStep] = useState<Step>(1);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);

  // Step 1: template
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [useBlank, setUseBlank] = useState(false);

  // Step 2: identity
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [departmentId, setDepartmentId] = useState("");

  // Step 3: config overrides
  const [ragEnabled, setRagEnabled] = useState(false);
  const [preferredModel, setPreferredModel] = useState("");
  const [routingPolicy, setRoutingPolicy] = useState("");

  // AI template generation
  const [aiDescription, setAiDescription] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiTemplate, setAiTemplate] = useState<{
    name: string;
    description: string;
    tier: string;
    layerConfig: AgentTemplate["layerConfig"];
    defaultAgentConfig: Record<string, unknown>;
  } | null>(null);

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [tmplRes, deptRes] = await Promise.all([
          fetchWithTenant("/api/agent-templates"),
          fetchWithTenant("/api/departments"),
        ]);
        if (tmplRes.ok) setTemplates(await tmplRes.json());
        if (deptRes.ok) setDepartments(await deptRes.json());
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  // Apply template defaults when selecting
  function selectTemplate(t: AgentTemplate) {
    setSelectedTemplateId(t.id);
    setUseBlank(false);
    const cfg = t.defaultAgentConfig;
    setRagEnabled(cfg.rag_enabled === true);
    setPreferredModel(typeof cfg.preferred_model === "string" ? cfg.preferred_model : "");
    setRoutingPolicy(typeof cfg.routing_policy === "string" ? cfg.routing_policy : "");
  }

  function selectBlank() {
    setSelectedTemplateId(null);
    setUseBlank(true);
    setRagEnabled(false);
    setPreferredModel("");
    setRoutingPolicy("");
  }

  async function handleAiGenerate() {
    if (aiDescription.trim().length < 10) return;
    setAiGenerating(true);
    setError(null);
    try {
      const res = await fetchWithTenant("/api/agent-templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: aiDescription.trim() }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(
          typeof b.error === "string" ? b.error : b.error?.message ?? `HTTP ${res.status}`,
        );
      }
      const data = await res.json();
      setAiTemplate(data.template);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate template");
    } finally {
      setAiGenerating(false);
    }
  }

  function applyAiTemplate() {
    if (!aiTemplate) return;
    // Pre-fill wizard with generated values
    setName(aiTemplate.name);
    setDescription(aiTemplate.description);
    const cfg = aiTemplate.defaultAgentConfig;
    setRagEnabled(cfg.rag_enabled === true);
    setPreferredModel(typeof cfg.preferred_model === "string" ? cfg.preferred_model : "");
    setRoutingPolicy(typeof cfg.routing_policy === "string" ? cfg.routing_policy : "");
    setSelectedTemplateId(null);
    setUseBlank(true);
    setStep(2);
  }

  async function saveAiTemplate() {
    if (!aiTemplate) return;
    setAiGenerating(true);
    try {
      const res = await fetchWithTenant("/api/agent-templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: aiDescription.trim(), save: true }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(
          typeof b.error === "string" ? b.error : b.error?.message ?? `HTTP ${res.status}`,
        );
      }
      const data = await res.json();
      // Refresh templates list to include the saved one
      const tmplRes = await fetchWithTenant("/api/agent-templates");
      if (tmplRes.ok) setTemplates(await tmplRes.json());
      // Select the newly saved template
      if (data.saved?.id) {
        setSelectedTemplateId(data.saved.id);
        setUseBlank(false);
      }
      setAiTemplate(null);
      setAiDescription("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save template");
    } finally {
      setAiGenerating(false);
    }
  }

  function canAdvance(): boolean {
    if (step === 1) return selectedTemplateId !== null || useBlank;
    if (step === 2) return name.trim().length > 0;
    return true;
  }

  async function handleCreate() {
    setSubmitting(true);
    setError(null);

    try {
      if (selectedTemplate) {
        // Create from template via instantiate
        const res = await fetchWithTenant(`/api/agent-templates/${selectedTemplate.id}/instantiate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            departmentId: departmentId || undefined,
            configOverrides: {
              description: description || undefined,
              rag_enabled: ragEnabled,
              preferred_model: preferredModel || undefined,
              routing_policy: routingPolicy || undefined,
            },
          }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(
            typeof b.error === "string" ? b.error : b.error?.message ?? `HTTP ${res.status}`,
          );
        }
        const data = await res.json();
        router.push(`/agents/${data.agent.id}`);
      } else {
        // Create blank agent
        const res = await fetchWithTenant("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            type: "worker",
            description: description || undefined,
            departmentId: departmentId || undefined,
            config: {
              rag_enabled: ragEnabled,
              preferred_model: preferredModel || undefined,
              routing_policy: routingPolicy || undefined,
            },
          }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(
            typeof b.error === "string" ? b.error : b.error?.message ?? `HTTP ${res.status}`,
          );
        }
        const data = await res.json();
        router.push(`/agents/${data.id}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create agent");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-200 rounded-xl" />
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
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Create Agent</h1>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {STEP_LABELS.map((label, i) => {
          const s = (i + 1) as Step;
          const active = s === step;
          const done = s < step;
          return (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <div className={`w-8 h-px ${done ? "bg-brand-400" : "bg-gray-200"}`} />}
              <div className="flex items-center gap-1.5">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                    active
                      ? "bg-brand-600 text-white"
                      : done
                        ? "bg-brand-100 text-brand-700"
                        : "bg-gray-100 text-gray-400"
                  }`}
                >
                  {done ? "\u2713" : s}
                </div>
                <span className={`text-xs ${active ? "text-brand-700 font-semibold" : "text-gray-400"}`}>
                  {label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Step 1: Template Selection */}
      {step === 1 && (
        <div className="space-y-4">
          {/* AI Template Generation */}
          <div className="bg-gradient-to-r from-brand-50 to-indigo-50 rounded-xl border border-brand-200 p-4">
            <p className="text-sm font-medium text-gray-800 mb-2">Generate from Description</p>
            <textarea
              value={aiDescription}
              onChange={(e) => setAiDescription(e.target.value)}
              rows={2}
              placeholder="e.g. A support agent that answers billing questions using our help docs..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none bg-white"
            />
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={handleAiGenerate}
                disabled={aiGenerating || aiDescription.trim().length < 10}
                className="px-4 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                {aiGenerating ? "Generating..." : "Generate Template"}
              </button>
              {aiDescription.trim().length > 0 && aiDescription.trim().length < 10 && (
                <span className="text-xs text-gray-400">At least 10 characters needed</span>
              )}
            </div>

            {/* AI Generated Template Preview */}
            {aiTemplate && (
              <div className="mt-3 bg-white rounded-lg border border-gray-200 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-6 h-6 rounded bg-brand-100 flex items-center justify-center text-xs font-bold text-brand-700">
                    {TIER_ICONS[aiTemplate.tier] ?? "?"}
                  </span>
                  <span className="text-sm font-semibold text-gray-900">{aiTemplate.name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold ml-auto">
                    {aiTemplate.tier}
                  </span>
                </div>
                <p className="text-xs text-gray-600 mb-2">{aiTemplate.description}</p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {aiTemplate.layerConfig.model && (
                    <span className="inline-block px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-[10px] font-medium">
                      {aiTemplate.layerConfig.model}
                    </span>
                  )}
                  {aiTemplate.layerConfig.application && (
                    <span className="inline-block px-2 py-0.5 bg-blue-50 text-blue-600 rounded text-[10px] font-medium">
                      {aiTemplate.layerConfig.application}
                    </span>
                  )}
                  {(aiTemplate.defaultAgentConfig.rag_enabled as boolean) && (
                    <span className="inline-block px-2 py-0.5 bg-green-50 text-green-600 rounded text-[10px] font-medium">
                      RAG Enabled
                    </span>
                  )}
                  {typeof aiTemplate.defaultAgentConfig.routing_policy === "string" && (
                    <span className="inline-block px-2 py-0.5 bg-purple-50 text-purple-600 rounded text-[10px] font-medium">
                      {aiTemplate.defaultAgentConfig.routing_policy.replace("_", " ")}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={applyAiTemplate}
                    className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium rounded-lg transition-colors"
                  >
                    Use This Template
                  </button>
                  <button
                    onClick={saveAiTemplate}
                    disabled={aiGenerating}
                    className="px-3 py-1.5 border border-gray-300 hover:border-gray-400 text-gray-700 text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
                  >
                    {aiGenerating ? "Saving..." : "Save as Template"}
                  </button>
                </div>
              </div>
            )}

            {error && !submitting && (
              <div className="mt-2 rounded-lg bg-red-50 border border-red-200 px-3 py-1.5 text-xs text-red-700">
                {error}
              </div>
            )}
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white px-3 text-xs text-gray-400">or choose a template</span>
            </div>
          </div>

          <p className="text-sm text-gray-600">Choose a template or start from scratch.</p>
          <div className="grid grid-cols-2 gap-3">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => selectTemplate(t)}
                className={`text-left p-4 rounded-xl border-2 transition-all ${
                  selectedTemplateId === t.id
                    ? "border-brand-500 ring-2 ring-brand-200"
                    : TIER_COLORS[t.tier] ?? "border-gray-200"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-600">
                    {TIER_ICONS[t.tier] ?? "?"}
                  </span>
                  <span className="text-sm font-semibold text-gray-900">{t.name}</span>
                </div>
                {t.description && (
                  <p className="text-xs text-gray-500 mt-1 line-clamp-2">{t.description}</p>
                )}
                <span className="inline-block mt-2 text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
                  {t.tier}
                </span>
              </button>
            ))}
            <button
              onClick={selectBlank}
              className={`text-left p-4 rounded-xl border-2 border-dashed transition-all ${
                useBlank ? "border-brand-500 ring-2 ring-brand-200" : "border-gray-300"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="w-6 h-6 rounded bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-400">
                  +
                </span>
                <span className="text-sm font-semibold text-gray-700">Blank Agent</span>
              </div>
              <p className="text-xs text-gray-400 mt-1">Start from scratch with no template</p>
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Agent Identity */}
      {step === 2 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Agent Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Give it a clear name your team will recognise"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Describe the agent so it knows how to behave"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
            <select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">None</option>
              {departments
                .filter((d) => d.status === "active")
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
      )}

      {/* Step 3: Configuration */}
      {step === 3 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-5">
          <p className="text-sm text-gray-600">
            Configure model and data layers.
            {selectedTemplate && (
              <span className="text-gray-400"> Defaults from {selectedTemplate.name} template.</span>
            )}
          </p>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Preferred Model</label>
            <select
              value={preferredModel}
              onChange={(e) => setPreferredModel(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">Default (claude-sonnet-4-6)</option>
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
              <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (fast/cheap)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Routing Policy</label>
            <select
              value={routingPolicy}
              onChange={(e) => setRoutingPolicy(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">Balanced (default)</option>
              <option value="cost_sensitive">Cost Sensitive</option>
              <option value="accuracy_first">Accuracy First</option>
              <option value="speed_optimized">Speed Optimized</option>
            </select>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="rag-enabled"
              checked={ragEnabled}
              onChange={(e) => setRagEnabled(e.target.checked)}
              className="h-4 w-4 text-brand-600 rounded border-gray-300 focus:ring-brand-500"
            />
            <label htmlFor="rag-enabled" className="text-sm text-gray-700">
              Enable RAG (Knowledge Retrieval)
            </label>
          </div>
          {ragEnabled && (
            <p className="text-xs text-gray-400 ml-7 -mt-2">
              After creation, upload knowledge documents in the agent detail &rarr; Knowledge tab.
            </p>
          )}
        </div>
      )}

      {/* Step 4: Review */}
      {step === 4 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <p className="text-sm font-medium text-gray-700">Review your agent configuration:</p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-gray-400">Template</p>
              <p className="font-medium text-gray-800">{selectedTemplate?.name ?? "Blank"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Name</p>
              <p className="font-medium text-gray-800">{name}</p>
            </div>
            {description && (
              <div className="col-span-2">
                <p className="text-xs text-gray-400">Description</p>
                <p className="text-gray-700">{description}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-400">Model</p>
              <p className="font-medium text-gray-800">{preferredModel || "Default"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Routing</p>
              <p className="font-medium text-gray-800">{routingPolicy || "Balanced"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">RAG</p>
              <p className="font-medium text-gray-800">{ragEnabled ? "Enabled" : "Disabled"}</p>
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Navigation buttons */}
      <div className="flex justify-between mt-6">
        <button
          onClick={() => step > 1 ? setStep((step - 1) as Step) : router.push("/agents")}
          className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
        >
          {step === 1 ? "Cancel" : "Back"}
        </button>

        {step < 4 ? (
          <button
            onClick={() => setStep((step + 1) as Step)}
            disabled={!canAdvance()}
            className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            Next
          </button>
        ) : (
          <button
            onClick={handleCreate}
            disabled={submitting}
            className="px-5 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {submitting ? "Creating..." : "Create Agent"}
          </button>
        )}
      </div>
    </div>
  );
}
