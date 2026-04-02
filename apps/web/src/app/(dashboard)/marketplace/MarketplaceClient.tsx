"use client";

import { useEffect, useState, useCallback } from "react";

interface MarketplaceTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tier: string;
  installCount: number;
  tags: string[];
  publishedAt: string | null;
}

const TIER_COLORS: Record<string, string> = {
  simple: "bg-gray-100 text-gray-700",
  rag: "bg-blue-100 text-blue-700",
  autonomous: "bg-purple-100 text-purple-700",
  enterprise: "bg-amber-100 text-amber-700",
};

const TIER_OPTIONS = ["All", "simple", "rag", "autonomous", "enterprise"];

export function MarketplaceClient() {
  const [templates, setTemplates] = useState<MarketplaceTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("All");
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [installed, setInstalled] = useState<Set<string>>(new Set());

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tierFilter !== "All") params.set("tier", tierFilter);
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/agent-templates/marketplace?${params}`);
      if (res.ok) {
        const data = await res.json();
        setTemplates(data.templates ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [tierFilter, search]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchTemplates();
    }, 300);
    return () => clearTimeout(timer);
  }, [fetchTemplates]);

  const handleInstall = async (templateId: string) => {
    setInstalling((prev) => new Set(prev).add(templateId));
    try {
      const res = await fetch(`/api/agent-templates/${templateId}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        setInstalled((prev) => new Set(prev).add(templateId));
      }
    } finally {
      setInstalling((prev) => {
        const next = new Set(prev);
        next.delete(templateId);
        return next;
      });
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Marketplace</h1>
        <p className="text-sm text-gray-500 mt-1">
          Browse and install agent templates published by other companies.
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-6">
        <input
          type="text"
          placeholder="Search templates..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
        />
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {TIER_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t === "All" ? "All Tiers" : t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {/* Template Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 animate-pulse">
              <div className="h-5 w-3/4 bg-gray-200 rounded mb-3" />
              <div className="h-4 w-full bg-gray-100 rounded mb-2" />
              <div className="h-4 w-2/3 bg-gray-100 rounded mb-4" />
              <div className="h-8 w-24 bg-gray-200 rounded" />
            </div>
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
          <p className="text-sm text-gray-400">No templates found in the marketplace.</p>
          <p className="text-xs text-gray-300 mt-1">Check back later or adjust your filters.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((tmpl) => {
            const isInstalling = installing.has(tmpl.id);
            const isInstalled = installed.has(tmpl.id);
            const tags = Array.isArray(tmpl.tags) ? tmpl.tags : [];

            return (
              <div
                key={tmpl.id}
                className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex flex-col justify-between hover:shadow-md transition-shadow"
              >
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-semibold text-gray-900 truncate">{tmpl.name}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase shrink-0 ${
                        TIER_COLORS[tmpl.tier] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {tmpl.tier}
                    </span>
                  </div>
                  {tmpl.description && (
                    <p className="text-xs text-gray-500 line-clamp-2 mb-3">{tmpl.description}</p>
                  )}
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-gray-400 flex items-center gap-1">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {tmpl.installCount}
                  </span>
                  <button
                    onClick={() => handleInstall(tmpl.id)}
                    disabled={isInstalling || isInstalled}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                      isInstalled
                        ? "bg-green-100 text-green-700 cursor-default"
                        : isInstalling
                          ? "bg-gray-100 text-gray-400 cursor-wait"
                          : "bg-brand-600 text-white hover:bg-brand-700"
                    }`}
                  >
                    {isInstalled ? "Installed" : isInstalling ? "Installing..." : "Install"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
