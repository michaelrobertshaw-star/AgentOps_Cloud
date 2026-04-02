"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

interface Connector {
  id: string;
  type: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
}

interface Skill {
  id: string;
  name: string;
  description: string | null;
  urlKey: string;
  version: string | null;
  updatedAt: string;
}

interface AgentTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tier: string;
  isBuiltIn: boolean;
  companyId: string | null;
  visibility?: string;
  installCount?: number;
  tags?: string[];
}

type LayerTab = "infrastructure" | "model" | "data" | "orchestration" | "templates";

const LAYER_TABS: { key: LayerTab; label: string; description: string }[] = [
  { key: "infrastructure", label: "Infrastructure", description: "Where models run (API connectors, cloud providers)" },
  { key: "model", label: "Models", description: "Available AI models and their capabilities" },
  { key: "data", label: "Data Sources", description: "External databases, documents, and knowledge stores" },
  { key: "orchestration", label: "Orchestration", description: "Skills that define how agents think and execute" },
  { key: "templates", label: "Templates", description: "Pre-configured agent blueprints" },
];

const INFRA_TYPES = ["claude_api", "claude_browser", "aws_bedrock", "gcp_vertex", "replicate", "modal"];
const DATA_TYPES = ["postgres_db", "vector_db", "rest_api", "pdf_docs"];

const AVAILABLE_MODELS = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic", tier: "Premium", speed: "Medium", cost: "$3.00 / $15.00 per 1M tokens" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "Anthropic", tier: "Fast", speed: "Fast", cost: "$0.80 / $4.00 per 1M tokens" },
  { id: "anthropic.claude-sonnet-4-6-v1:0", name: "Claude Sonnet 4.6 (Bedrock)", provider: "AWS Bedrock", tier: "Premium", speed: "Medium", cost: "$3.00 / $15.00 per 1M tokens" },
  { id: "anthropic.claude-3-haiku-20240307-v1:0", name: "Claude 3 Haiku (Bedrock)", provider: "AWS Bedrock", tier: "Fast", speed: "Fast", cost: "$0.25 / $1.25 per 1M tokens" },
  { id: "claude-sonnet-4-6@20250514", name: "Claude Sonnet 4.6 (Vertex)", provider: "GCP Vertex", tier: "Premium", speed: "Medium", cost: "$3.00 / $15.00 per 1M tokens" },
  { id: "claude-haiku-4-5@20251001", name: "Claude Haiku 4.5 (Vertex)", provider: "GCP Vertex", tier: "Fast", speed: "Fast", cost: "$0.80 / $4.00 per 1M tokens" },
];

const TIER_COLORS: Record<string, string> = {
  simple: "bg-gray-100 text-gray-700",
  rag: "bg-blue-100 text-blue-700",
  autonomous: "bg-purple-100 text-purple-700",
  enterprise: "bg-amber-100 text-amber-700",
};

const TYPE_COLORS: Record<string, string> = {
  claude_api: "bg-purple-100 text-purple-700",
  claude_browser: "bg-indigo-100 text-indigo-700",
  aws_bedrock: "bg-amber-100 text-amber-700",
  gcp_vertex: "bg-blue-100 text-blue-700",
  postgres_db: "bg-sky-100 text-sky-700",
  vector_db: "bg-violet-100 text-violet-700",
  rest_api: "bg-teal-100 text-teal-700",
  pdf_docs: "bg-rose-100 text-rose-700",
  replicate: "bg-lime-100 text-lime-700",
  modal: "bg-fuchsia-100 text-fuchsia-700",
  webhook: "bg-cyan-100 text-cyan-700",
  http_get: "bg-green-100 text-green-700",
  minio_storage: "bg-orange-100 text-orange-700",
};

function TypeBadge({ type }: { type: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${TYPE_COLORS[type] ?? "bg-gray-100 text-gray-600"}`}>
      {type.replace(/_/g, " ")}
    </span>
  );
}

export function LayerLibraryClient() {
  const [activeTab, setActiveTab] = useState<LayerTab>("infrastructure");
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [connRes, skillRes, tmplRes] = await Promise.all([
        fetchWithTenant("/api/connectors"),
        fetchWithTenant("/api/skills"),
        fetchWithTenant("/api/agent-templates"),
      ]);
      if (connRes.ok) setConnectors(await connRes.json());
      if (skillRes.ok) setSkills(await skillRes.json());
      if (tmplRes.ok) setTemplates(await tmplRes.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handlePublishToggle = async (tmpl: AgentTemplate) => {
    const action = tmpl.visibility === "public" ? "unpublish" : "publish";
    setPublishing((prev) => new Set(prev).add(tmpl.id));
    try {
      const res = await fetchWithTenant(`/api/agent-templates/${tmpl.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: tmpl.tags ?? [] }),
      });
      if (res.ok) {
        setTemplates((prev) =>
          prev.map((t) =>
            t.id === tmpl.id
              ? { ...t, visibility: action === "publish" ? "public" : "private" }
              : t
          )
        );
      }
    } finally {
      setPublishing((prev) => {
        const next = new Set(prev);
        next.delete(tmpl.id);
        return next;
      });
    }
  };

  const infraConnectors = connectors.filter((c) => INFRA_TYPES.includes(c.type));
  const dataConnectors = connectors.filter((c) => DATA_TYPES.includes(c.type));
  const activeTabMeta = LAYER_TABS.find((t) => t.key === activeTab)!;

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-200 rounded-xl" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Layer Library</h1>
        <p className="text-sm text-gray-500 mt-1">
          Browse available infrastructure, models, data sources, orchestration skills, and templates.
        </p>
      </div>

      {/* Layer tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-lg p-1">
        {LAYER_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
              activeTab === tab.key
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <p className="text-sm text-gray-500 mb-4">{activeTabMeta.description}</p>

      {/* Infrastructure Layer */}
      {activeTab === "infrastructure" && (
        <div className="space-y-3">
          {infraConnectors.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
              <p className="text-sm text-gray-400">No infrastructure connectors configured.</p>
              <p className="text-xs text-gray-300 mt-1">Add connectors in Admin &rarr; Company &rarr; Connectors.</p>
            </div>
          ) : (
            infraConnectors.map((conn) => (
              <div key={conn.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <TypeBadge type={conn.type} />
                    <span className="text-sm font-semibold text-gray-900">{conn.name}</span>
                    {conn.isDefault && (
                      <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">DEFAULT</span>
                    )}
                  </div>
                  {conn.description && <p className="text-xs text-gray-500">{conn.description}</p>}
                </div>
                <span className="text-xs text-gray-400">{new Date(conn.createdAt).toLocaleDateString()}</span>
              </div>
            ))
          )}

          <div className="bg-gray-50 rounded-xl border border-dashed border-gray-300 p-4 mt-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Available Providers</p>
            <div className="flex flex-wrap gap-2">
              {["Claude API", "Claude Browser", "AWS Bedrock", "GCP Vertex AI", "Replicate", "Modal"].map((p) => (
                <span key={p} className="text-xs bg-white border border-gray-200 rounded px-2 py-1 text-gray-600">{p}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Model Layer */}
      {activeTab === "model" && (
        <div className="space-y-3">
          {AVAILABLE_MODELS.map((model) => (
            <div key={model.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900">{model.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    model.tier === "Premium" ? "bg-purple-100 text-purple-700" : "bg-green-100 text-green-700"
                  }`}>
                    {model.tier}
                  </span>
                </div>
                <span className="text-xs text-gray-400">{model.provider}</span>
              </div>
              <div className="flex gap-4 text-xs text-gray-500 mt-1">
                <span>Speed: {model.speed}</span>
                <span>Cost: {model.cost}</span>
              </div>
              <p className="text-[10px] text-gray-300 mt-1 font-mono">{model.id}</p>
            </div>
          ))}
        </div>
      )}

      {/* Data Sources Layer */}
      {activeTab === "data" && (
        <div className="space-y-3">
          {dataConnectors.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
              <p className="text-sm text-gray-400">No data source connectors configured.</p>
            </div>
          ) : (
            dataConnectors.map((conn) => (
              <div key={conn.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <TypeBadge type={conn.type} />
                    <span className="text-sm font-semibold text-gray-900">{conn.name}</span>
                  </div>
                  {conn.description && <p className="text-xs text-gray-500">{conn.description}</p>}
                </div>
                <span className="text-xs text-gray-400">{new Date(conn.createdAt).toLocaleDateString()}</span>
              </div>
            ))
          )}

          <div className="bg-gray-50 rounded-xl border border-dashed border-gray-300 p-4 mt-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Available Data Sources</p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { type: "postgres_db", label: "PostgreSQL", desc: "Read-only query against external databases" },
                { type: "vector_db", label: "Vector DB", desc: "pgvector-based semantic search (built-in)" },
                { type: "pdf_docs", label: "PDF Documents", desc: "Extract text from PDFs for RAG ingestion" },
                { type: "rest_api", label: "REST API", desc: "Fetch data from external HTTP endpoints" },
              ].map((ds) => (
                <div key={ds.type} className="bg-white border border-gray-200 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <TypeBadge type={ds.type} />
                    <span className="text-sm font-medium text-gray-800">{ds.label}</span>
                  </div>
                  <p className="text-xs text-gray-400">{ds.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Orchestration Layer */}
      {activeTab === "orchestration" && (
        <div className="space-y-3">
          {skills.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
              <p className="text-sm text-gray-400">No skills configured.</p>
            </div>
          ) : (
            skills.map((skill) => (
              <div key={skill.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-gray-900">{skill.name}</span>
                    {skill.version && (
                      <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">
                        v{skill.version}
                      </span>
                    )}
                  </div>
                  {skill.description && <p className="text-xs text-gray-500">{skill.description}</p>}
                </div>
                <span className="text-xs text-gray-400">
                  {skill.updatedAt ? new Date(skill.updatedAt).toLocaleDateString() : ""}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Templates Layer */}
      {activeTab === "templates" && (
        <div className="grid grid-cols-2 gap-3">
          {templates.length === 0 ? (
            <div className="col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
              <p className="text-sm text-gray-400">No templates available.</p>
            </div>
          ) : (
            templates.map((tmpl) => (
              <div key={tmpl.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-gray-900">{tmpl.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${
                    TIER_COLORS[tmpl.tier] ?? "bg-gray-100 text-gray-600"
                  }`}>
                    {tmpl.tier}
                  </span>
                  {tmpl.isBuiltIn && (
                    <span className="text-[10px] bg-brand-100 text-brand-700 px-1.5 py-0.5 rounded font-medium">BUILT-IN</span>
                  )}
                  {tmpl.visibility === "public" && (
                    <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">PUBLISHED</span>
                  )}
                </div>
                {tmpl.description && <p className="text-xs text-gray-500 mt-1">{tmpl.description}</p>}
                <div className="flex items-center justify-between mt-2">
                  <p className="text-[10px] text-gray-300 font-mono">{tmpl.slug}</p>
                  {tmpl.companyId && !tmpl.isBuiltIn && (
                    <button
                      onClick={() => handlePublishToggle(tmpl)}
                      disabled={publishing.has(tmpl.id)}
                      className={`text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors ${
                        tmpl.visibility === "public"
                          ? "bg-gray-100 text-gray-600 hover:bg-gray-200"
                          : "bg-brand-600 text-white hover:bg-brand-700"
                      } ${publishing.has(tmpl.id) ? "opacity-50 cursor-wait" : ""}`}
                    >
                      {publishing.has(tmpl.id)
                        ? "..."
                        : tmpl.visibility === "public"
                          ? "Unpublish"
                          : "Publish"}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
