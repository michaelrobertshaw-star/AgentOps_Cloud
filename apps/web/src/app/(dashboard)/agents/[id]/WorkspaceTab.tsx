"use client";

import { useEffect, useState, useCallback, useRef, lazy, Suspense, useMemo } from "react";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

const TemplateDesigner = lazy(() => import("./TemplateDesigner"));

// ── Types ────────────────────────────────────────────────────

type StepType = "pull" | "filter" | "parse" | "create_view" | "create_doc" | "save";

interface WorkflowStep {
  id: string;
  type: StepType;
  config: Record<string, unknown>;
}

interface ToolField {
  key: string;
  label: string;
  type: string;
  description?: string | null;
  enum_values?: string[] | null;
  unit?: string | null;
}

interface ToolResource {
  tool_id: string;
  tool_name: string;
  display_name: string;
  description: string;
  connector_name: string;
  connector_id: string;
  fields: ToolField[]; // Input params (for PULL query config)
  response_fields: Array<{ key: string; label: string; type: string; source?: string }>; // Output columns (for FILTER/PARSE)
}

interface Column {
  key: string;
  label: string;
}

interface RunResult {
  id: string;
  status: string;
  step_results: Array<{
    stepId: string;
    label: string;
    status: string;
    rowCount: number;
    duration_ms: number;
    message?: string;
    error?: string;
  }>;
  output_data: Record<string, unknown>[] | null;
  output_columns: Column[] | null;
  ai_notes: string | null;
  rows_processed: number;
  duration_ms: number | null;
  error: string | null;
}

// ── Step type config ────────────────────────────────────────

const STEP_TYPES: { key: StepType; label: string; tag: string; color: string; bg: string; description: string }[] = [
  { key: "pull", label: "PULL", tag: "ACTION", color: "text-green-700", bg: "bg-green-100 border-green-300", description: "Pull data from an API connector" },
  { key: "filter", label: "FILTER", tag: "VALUE", color: "text-red-600", bg: "bg-red-50 border-red-300", description: "Filter rows by a condition" },
  { key: "parse", label: "PARSE", tag: "ACTION", color: "text-green-700", bg: "bg-green-100 border-green-300", description: "Select which fields to include" },
  { key: "create_view", label: "VIEW", tag: "ACTION", color: "text-blue-700", bg: "bg-blue-50 border-blue-300", description: "Display results as table or chart" },
  { key: "create_doc", label: "CREATE", tag: "CREATE", color: "text-purple-700", bg: "bg-purple-50 border-purple-300", description: "Generate a document per record" },
  { key: "save", label: "SAVE", tag: "ACTION", color: "text-amber-700", bg: "bg-amber-50 border-amber-300", description: "Save/export the output" },
];

// ── Smart default fields for PARSE step ──────────────────
// These are the commonly useful fields shown when user clicks "clear default".
// Matches the fields needed for the HCPF trip report PDF + common dispatch fields.
const SMART_DEFAULT_FIELDS = [
  "trip_id", "status", "name", "passenger_name", "phone",
  "pickup_date", "arrive_date", "booked_date", "created_date", "close_date",
  "address.formatted", "destination.formatted",
  "driver.name", "driver.phone",
  "distance", "fare", "estimate_fare",
  "account.name", "account_name",
  "payment.signature", "payment.status",
  "source", "contact_date",
];

// ── Step default persistence (localStorage) ──────────────────

const STEP_DEFAULTS_KEY = "workspace_step_defaults";

function getSavedStepDefault(stepType: StepType): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(STEP_DEFAULTS_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw);
    return all[stepType] ?? null;
  } catch {
    return null;
  }
}

function saveStepDefault(stepType: StepType, config: Record<string, unknown>) {
  try {
    const raw = localStorage.getItem(STEP_DEFAULTS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[stepType] = config;
    localStorage.setItem(STEP_DEFAULTS_KEY, JSON.stringify(all));
  } catch {
    // localStorage unavailable — silently fail
  }
}

function clearStepDefault(stepType: StepType) {
  try {
    const raw = localStorage.getItem(STEP_DEFAULTS_KEY);
    if (!raw) return;
    const all = JSON.parse(raw);
    delete all[stepType];
    localStorage.setItem(STEP_DEFAULTS_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

const FILTER_OPERATORS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  contains: "contains",
  not_contains: "does not contain",
};

// ── PDF File List with Preview ───────────────────────────────

function PdfFileList({
  pdfFiles,
  runId,
  totalCount,
}: {
  pdfFiles: Record<string, unknown>[];
  runId?: string;
  totalCount: number;
}) {
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPage, setPreviewPage] = useState(0);
  const PAGE_SIZE = 10;

  const visibleFiles = pdfFiles.slice(0, (previewPage + 1) * PAGE_SIZE);
  const hasMore = visibleFiles.length < pdfFiles.length;

  // Fetch PDF with auth and create blob URL
  const openPreview = useCallback(async (filename: string) => {
    if (!runId) return;
    if (previewFile === filename) {
      // Toggle off
      setPreviewFile(null);
      if (blobUrl) { URL.revokeObjectURL(blobUrl); setBlobUrl(null); }
      return;
    }
    setPreviewFile(filename);
    setLoadingPreview(true);
    setPreviewError(null);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    try {
      const res = await fetchWithTenant(
        `/api/workspace/runs/${runId}/file/${encodeURIComponent(filename)}`
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const blob = await res.blob();
      if (blob.size === 0) throw new Error("Empty PDF response");
      const url = URL.createObjectURL(blob);
      setBlobUrl(url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("PDF preview failed:", msg);
      setPreviewError(msg);
      setBlobUrl(null);
    } finally {
      setLoadingPreview(false);
    }
  }, [runId, previewFile, blobUrl]);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [blobUrl]);

  return (
    <div className="border-b border-gray-100">
      {/* Preview */}
      {previewFile && (
        <div className="border-b border-gray-200 bg-gray-50">
          <div className="flex items-center justify-between px-3 py-1.5 bg-gray-100 border-b border-gray-200">
            <span className="text-[10px] font-medium text-gray-700 truncate flex-1">{previewFile}</span>
            <div className="flex items-center gap-2 flex-shrink-0">
              {blobUrl && (
                <a
                  href={blobUrl}
                  download={previewFile}
                  className="text-[10px] text-blue-600 hover:text-blue-800 font-medium"
                >
                  Download
                </a>
              )}
              <button
                onClick={() => { setPreviewFile(null); if (blobUrl) { URL.revokeObjectURL(blobUrl); setBlobUrl(null); } }}
                className="text-[10px] text-gray-400 hover:text-gray-600"
              >
                close
              </button>
            </div>
          </div>
          {loadingPreview ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin h-6 w-6 border-2 border-purple-500 border-t-transparent rounded-full" />
            </div>
          ) : blobUrl ? (
            <iframe
              src={blobUrl}
              className="w-full border-0"
              style={{ height: 500 }}
              title={`Preview: ${previewFile}`}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 gap-1">
              <span className="text-xs text-red-500 font-medium">Failed to load preview</span>
              {previewError && <span className="text-[10px] text-red-400 max-w-md text-center break-all">{previewError}</span>}
            </div>
          )}
        </div>
      )}

      {/* File list */}
      <div className="px-3 py-2">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-bold text-purple-600 uppercase tracking-wide">
            {totalCount} PDFs Generated
          </span>
          {!runId && (
            <span className="text-[9px] text-gray-400">Run full pipeline to preview</span>
          )}
        </div>
        <div className="max-h-40 overflow-auto space-y-0.5">
          {visibleFiles.map((r, i) => {
            const filename = String(r._pdf_file);
            const isActive = previewFile === filename;
            return (
              <div
                key={i}
                className={`flex items-center gap-1.5 text-[10px] rounded px-1 py-0.5 cursor-pointer transition-colors ${
                  isActive
                    ? "bg-purple-100 text-purple-700 font-medium"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
                onClick={() => openPreview(filename)}
              >
                <svg className={`w-3 h-3 flex-shrink-0 ${isActive ? "text-purple-500" : "text-red-400"}`} fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd"/>
                </svg>
                <span className="truncate">{filename}</span>
              </div>
            );
          })}
          {hasMore && (
            <button
              onClick={() => setPreviewPage((p) => p + 1)}
              className="text-[10px] text-blue-600 hover:text-blue-800 font-medium pl-4 py-1"
            >
              Show more ({pdfFiles.length - visibleFiles.length} remaining)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Searchable Dropdown ─────────────────────────────────────

function SearchSelect({
  value,
  options,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  options: { value: string; label: string; sublabel?: string }[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected = options.find((o) => o.value === value);
  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()) || o.sublabel?.toLowerCase().includes(search.toLowerCase()))
    : options;

  return (
    <div ref={ref} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => { setOpen(!open); setSearch(""); setTimeout(() => inputRef.current?.focus(), 50); }}
        className="w-full flex items-center justify-between gap-1 border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm bg-white hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 text-left font-medium min-w-[180px]"
      >
        <span className={selected ? "text-gray-800" : "text-gray-400"}>
          {selected ? selected.label : placeholder ?? "Select..."}
        </span>
        <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[220px] bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-hidden">
          {/* Search input */}
          <div className="p-1.5 border-b border-gray-100">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
              autoFocus
            />
          </div>
          <div className="overflow-y-auto max-h-48">
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-gray-400">No results</div>
            )}
            {filtered.map((opt) => (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); setSearch(""); }}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-brand-50 transition-colors ${
                  opt.value === value ? "bg-brand-50 text-brand-700 font-medium" : "text-gray-700"
                }`}
              >
                {opt.label}
                {opt.sublabel && <span className="text-[10px] text-gray-400 ml-1">({opt.sublabel})</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Component ───────────────────────────────────────────────

export default function WorkspaceTab({ agentId }: { agentId: string }) {
  // Resources from connectors
  const [resources, setResources] = useState<ToolResource[]>([]);

  // Steps
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [addingStep, setAddingStep] = useState(false);

  // Template
  const [templateContent, setTemplateContent] = useState("");
  const [templateName, setTemplateName] = useState("");

  // Execution
  const [running, setRunning] = useState(false);
  const [currentRun, setCurrentRun] = useState<RunResult | null>(null);
  const [pollTimer, setPollTimer] = useState<ReturnType<typeof setInterval> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Table state
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const PAGE_SIZE = 25;

  // Expanded signature lightbox
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  // Saved workflows
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string; pipeline: WorkflowStep[]; step_count: number; last_run_at: string | null }>>([]);
  const [workflowName, setWorkflowName] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  // Per-step test results
  const [stepTestResults, setStepTestResults] = useState<Record<string, { loading: boolean; data: unknown; error: string | null; showRaw: boolean }>>({});

  // Probed real API fields (populated by sample fetch)
  const [probedFields, setProbedFields] = useState<Array<{ key: string; label: string; type: string; sample_value?: string | null; unit?: string | null }>>([]);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probedFieldCount, setProbedFieldCount] = useState(0);

  // Step default save feedback — tracks which step types just saved (for brief "Saved" indicator)
  const [savedDefaultFeedback, setSavedDefaultFeedback] = useState<Record<string, boolean>>({});

  // Template designer
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; type: string; base_pdf_key: string | null; pdfme_schema: unknown }>>([]);
  const [designerTemplateId, setDesignerTemplateId] = useState<string | null>(null);
  const [renamingTemplateId, setRenamingTemplateId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Preview modal for SAVE step — shows actual rendered PDFs or data table fallback
  const [previewFiles, setPreviewFiles] = useState<Array<{ filename: string; runId: string; data?: Record<string, unknown> }> | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewBlobUrls, setPreviewBlobUrls] = useState<Record<number, string>>({});

  // ── Fetch PDF blob for preview modal ──
  useEffect(() => {
    if (!previewFiles || previewFiles.length === 0) {
      // Cleanup blob URLs when modal closes
      Object.values(previewBlobUrls).forEach((url) => URL.revokeObjectURL(url));
      setPreviewBlobUrls({});
      return;
    }
    const file = previewFiles[previewIndex];
    if (!file || !file.runId) return; // data-table mode — no PDF to fetch
    if (previewBlobUrls[previewIndex]) return; // already fetched
    let cancelled = false;
    fetchWithTenant(`/api/workspace/runs/${file.runId}/file/${encodeURIComponent(file.filename)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${body}`);
        }
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setPreviewBlobUrls((prev) => ({ ...prev, [previewIndex]: url }));
      })
      .catch((err) => {
        console.error("Failed to load PDF preview:", err);
      });
    return () => { cancelled = true; };
  }, [previewFiles, previewIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load resources ──

  useEffect(() => {
    fetchWithTenant(`/api/agents/${agentId}/workspace/fields`)
      .then((r) => r.ok ? r.json() : [])
      .then(setResources)
      .catch(() => {});
  }, [agentId]);

  // ── Load saved workflows ──

  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/workspace/workflows`);
      if (res.ok) setWorkflows(await res.json());
    } catch {}
  }, [agentId]);

  useEffect(() => { fetchWorkflows(); }, [fetchWorkflows]);

  // ── Load templates ──
  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetchWithTenant("/api/workspace/templates");
      if (res.ok) setTemplates(await res.json());
    } catch {}
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  // Cleanup timer
  useEffect(() => { return () => { if (pollTimer) clearInterval(pollTimer); }; }, [pollTimer]);

  // ── Probe real API fields when tool is selected ──

  const probeToolFields = useCallback(async (toolName: string, extraParams?: Record<string, unknown>) => {
    if (!toolName) { setProbedFields([]); setProbedFieldCount(0); return; }
    setProbing(true);
    setProbeError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/workspace/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool_name: toolName, sample_params: extraParams }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Probe failed" }));
        const errMsg = typeof err.error === "string" ? err.error : typeof err.error === "object" ? JSON.stringify(err.error) : "Failed to probe API";
        setProbeError(errMsg);
        // Fall back to response_mapping fields
        return;
      }
      const data = await res.json();
      setProbedFields(data.fields ?? []);
      setProbedFieldCount(data.field_count ?? 0);
    } catch (e) {
      setProbeError(e instanceof Error ? e.message : "Probe failed");
    } finally {
      setProbing(false);
    }
  }, [agentId]);

  // ── Derived state ──

  // The selected PULL tool
  const pullStep = steps.find((s) => s.type === "pull");
  const selectedTool = pullStep ? resources.find((r) => r.tool_name === pullStep.config.tool_name) : null;

  // INPUT fields: params you send TO the API (for PULL step config)
  const inputFields: ToolField[] = selectedTool?.fields ?? [];

  // OUTPUT fields: REAL columns from the API response (probed), fallback to response_mapping
  const outputFields: Array<{ key: string; label: string; type: string; enum_values?: string[] | null; unit?: string | null; sample_value?: string | null }> =
    probedFields.length > 0
      ? probedFields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type ?? "string",
          enum_values: null,
          unit: f.unit ?? null,
          sample_value: f.sample_value ?? null,
        }))
      : selectedTool?.response_fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type ?? "string",
          enum_values: null,
          unit: f.key.toLowerCase().includes("distance") || f.key.toLowerCase().includes("miles") ? "miles" :
                f.key.toLowerCase().includes("fare") || f.key.toLowerCase().includes("cost") ? "dollars" : null,
          sample_value: null,
        })) ?? [];

  // Parse step determines which fields show in table
  const parseStep = steps.find((s) => s.type === "parse");
  const selectedFields = (parseStep?.config.fields as string[]) ?? [];

  // ── Step manipulation ──

  function addStep(type: StepType) {
    const id = `step_${Date.now()}`;

    // Check for saved defaults first
    const saved = getSavedStepDefault(type);
    if (saved) {
      setSteps([...steps, { id, type, config: { ...saved } }]);
      setAddingStep(false);
      return;
    }

    // Fallback to built-in defaults
    const config: Record<string, unknown> = {};

    if (type === "pull") { config.tool_name = ""; config.params = {}; }
    if (type === "filter") { config.field = ""; config.operator = "eq"; config.value = ""; }
    if (type === "parse") {
      // Auto-select useful default fields from probed output
      const defaultKeyPatterns = [
        "trip_id", "status", "name", "phone", "account_id",
        "pickup_date", "arrive_date", "booked_date", "created_date", "close_date", "contact_date",
        "address.formatted", "destination.formatted",
        "distance", "estimate_fare", "actual",
        "source", "vehicle_type", "vehicle_group",
        "account", "account.name",
      ];
      const autoFields = outputFields
        .filter((f) => defaultKeyPatterns.some((p) => f.key === p || f.key.endsWith("." + p)))
        .map((f) => f.key);
      // If signature is enabled on the pull step, include signature fields
      const ps = steps.find((s) => s.type === "pull");
      if (ps && (ps.config.params as Record<string, unknown>)?.signature) {
        const sigFields = ["payment.signature", "signature"];
        for (const sf of sigFields) {
          if (!autoFields.includes(sf)) autoFields.push(sf);
        }
      }
      config.fields = autoFields.length > 0 ? autoFields : [];
    }
    if (type === "create_view") config.format = "table";
    if (type === "create_doc") { config.doc_type = "pdf"; config.template = ""; config.per_record = true; }
    if (type === "save") { config.format = "pdf"; config.filename_pattern = ""; }

    setSteps([...steps, { id, type, config }]);
    setAddingStep(false);
  }

  function updateStep(id: string, config: Record<string, unknown>) {
    setSteps(steps.map((s) => (s.id === id ? { ...s, config: { ...s.config, ...config } } : s)));
  }

  function removeStep(id: string) {
    setSteps(steps.filter((s) => s.id !== id));
  }

  // ── Test individual step ──

  async function testStep(stepId: string) {
    // Build pipeline up to and including this step
    const stepIdx = steps.findIndex((s) => s.id === stepId);
    if (stepIdx < 0) return;

    const partialSteps = steps.slice(0, stepIdx + 1);

    // Convert to pipeline format (same as handleRun)
    const pipeline = partialSteps.map((step, idx) => {
      switch (step.type) {
        case "pull":
          return {
            id: step.id, order: idx + 1, type: "action" as const,
            label: `Pull from ${resources.find((r) => r.tool_name === step.config.tool_name)?.display_name ?? step.config.tool_name}`,
            operation: "pull_data",
            config: {
              tool_name: step.config.tool_name,
              tool_params: {
                ...(step.config.params ?? {}),
                ...((() => { try { const p = JSON.parse(step.config.custom_json as string || "{}"); return typeof p === "object" && p !== null && !Array.isArray(p) ? p : {}; } catch { return {}; } })()),
              },
              signature_display: step.config.signature_display,
            },
            source_text: "",
          };
        case "filter":
          return {
            id: step.id, order: idx + 1, type: "value" as const,
            label: `Filter: ${step.config.field} ${step.config.operator} ${step.config.value}`,
            operation: "filter",
            config: { field: step.config.field, operator: step.config.operator, value: step.config.value },
            source_text: "",
          };
        case "parse":
          return {
            id: step.id, order: idx + 1, type: "action" as const,
            label: `Select fields: ${(step.config.fields as string[])?.join(", ")}`,
            operation: "transform",
            config: { pick: step.config.fields },
            source_text: "",
          };
        case "create_doc":
          return {
            id: step.id, order: idx + 1, type: "action" as const,
            label: `Create ${step.config.doc_type ?? "PDF"} documents`,
            operation: "generate_doc",
            config: {
              template_id: step.config.template,
              output_format: step.config.doc_type ?? "pdf",
              per_row: step.config.per_record ?? true,
              filename_pattern: step.config.filename_pattern ?? "{trip_id}-{name}.pdf",
            },
            source_text: "",
          };
        case "save":
          return {
            id: step.id, order: idx + 1, type: "action" as const,
            label: `Save as ${step.config.format ?? "pdf"}`,
            operation: "name_files",
            config: { pattern: step.config.filename_pattern || `{trip_id}-{name}.${step.config.format ?? "pdf"}` },
            source_text: "",
          };
        default:
          return {
            id: step.id, order: idx + 1, type: "action" as const,
            label: step.type, operation: "custom",
            config: { instruction: step.type },
            source_text: "",
          };
      }
    });

    setStepTestResults((prev) => ({
      ...prev,
      [stepId]: { loading: true, data: null, error: null, showRaw: false },
    }));

    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/workspace/test-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipeline }),
      });
      if (!res.ok) throw new Error(`Test failed (${res.status})`);
      const result = await res.json();

      // Async run — poll until completed
      if (result.async && result.run_id) {
        setStepTestResults((prev) => ({
          ...prev,
          [stepId]: { loading: true, data: null, error: null, showRaw: false },
        }));
        const pollInterval = setInterval(async () => {
          try {
            const pollRes = await fetchWithTenant(`/api/agents/${agentId}/workspace/runs/${result.run_id}`, { method: "GET" });
            if (!pollRes.ok) return;
            const pollData = await pollRes.json();
            const runStatus: string = pollData.status ?? "running";
            const progress: string = pollData.step_results?.[0]?.message ?? "Running...";
            if (runStatus === "completed" || runStatus === "error") {
              clearInterval(pollInterval);
              setStepTestResults((prev) => ({
                ...prev,
                [stepId]: { loading: false, data: pollData, error: pollData.error ?? null, showRaw: false },
              }));
            } else {
              // Show live progress
              setStepTestResults((prev) => ({
                ...prev,
                [stepId]: { loading: true, data: { _progress: progress }, error: null, showRaw: false },
              }));
            }
          } catch { /* keep polling */ }
        }, 5000);
        return; // don't fall through to field probing yet
      }

      setStepTestResults((prev) => ({
        ...prev,
        [stepId]: { loading: false, data: result, error: result.error ?? null, showRaw: false },
      }));

      // After a successful PULL test, update probed fields from actual output columns
      const testedStep = steps.find((s) => s.id === stepId);
      if (testedStep?.type === "pull" && result.output_data && Array.isArray(result.output_data) && result.output_data.length > 0) {
        const sampleRow = result.output_data[0];
        const keys = Object.keys(sampleRow);
        const newFields = keys.map((key) => {
          const val = sampleRow[key];
          const parts = key.split(".");
          const leaf = parts[parts.length - 1];
          const label = (parts.length > 1 ? parts.slice(-2) : [leaf])
            .join(" ")
            .replace(/_/g, " ")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/\b\w/g, (c: string) => c.toUpperCase());
          return {
            key,
            label,
            type: typeof val === "number" ? "number" : typeof val === "boolean" ? "boolean" : typeof val === "string" && /^\d{4}-\d{2}-\d{2}/.test(val) ? "date" : "string",
            sample_value: val != null ? String(val).slice(0, 100) : null,
            unit: key.toLowerCase().includes("distance") ? "miles" : key.toLowerCase().includes("fare") ? "dollars" : null,
          };
        });
        setProbedFields(newFields);
        setProbedFieldCount(newFields.length);
      }
    } catch (e) {
      setStepTestResults((prev) => ({
        ...prev,
        [stepId]: { loading: false, data: null, error: e instanceof Error ? e.message : "Test failed", showRaw: true },
      }));
    }
  }

  function toggleStepRaw(stepId: string) {
    setStepTestResults((prev) => {
      const cur = prev[stepId];
      if (!cur) return prev;
      return { ...prev, [stepId]: { ...cur, showRaw: !cur.showRaw } };
    });
  }

  function clearStepTest(stepId: string) {
    setStepTestResults((prev) => {
      const next = { ...prev };
      delete next[stepId];
      return next;
    });
  }

  // ── Build readable sentence ──

  function buildReadable(): string {
    const parts: string[] = [];
    for (const step of steps) {
      switch (step.type) {
        case "pull": {
          const tool = resources.find((r) => r.tool_name === step.config.tool_name);
          const params = step.config.params as Record<string, unknown> ?? {};
          const paramStr = Object.entries(params)
            .filter(([, v]) => v !== "" && v != null)
            .map(([k, v]) => {
              const field = inputFields.find((f) => f.key === k);
              return `${field?.label ?? k}: ${v}`;
            })
            .join(", ");
          parts.push(`Pull from ${tool?.display_name ?? step.config.tool_name ?? "?"} (${tool?.connector_name ?? ""})${paramStr ? ` with ${paramStr}` : ""}`);
          break;
        }
        case "filter": {
          const field = outputFields.find((f) => f.key === step.config.field);
          const op = FILTER_OPERATORS[step.config.operator as string] ?? step.config.operator;
          const unit = field?.unit ? ` ${field.unit}` : "";
          parts.push(`Filter: ${field?.label ?? step.config.field} ${op} ${step.config.value}${unit}`);
          break;
        }
        case "parse": {
          const fieldLabels = ((step.config.fields as string[]) ?? []).map((k) => {
            const f = outputFields.find((of) => of.key === k);
            return f?.label ?? k;
          });
          parts.push(`Parse: ${fieldLabels.join(", ") || "all fields"}`);
          break;
        }
        case "create_view":
          parts.push(`Create View: ${step.config.format ?? "table"}`);
          break;
        case "create_doc":
          parts.push(`Create ${step.config.doc_type ?? "PDF"} ${step.config.per_record ? "per record" : "(batch)"}`);
          break;
        case "save":
          parts.push(`Save as ${step.config.format ?? "PDF"}`);
          break;
      }
    }
    return parts.join(" → ");
  }

  // ── Execute ──

  async function handleRun() {
    if (steps.length === 0) return;
    setRunning(true);
    setError(null);
    setCurrentRun(null);

    try {
      // Convert steps to pipeline format the executor understands
      const pipeline = steps.map((step, idx) => {
        switch (step.type) {
          case "pull":
            return {
              id: step.id,
              order: idx + 1,
              type: "action" as const,
              label: `Pull from ${resources.find((r) => r.tool_name === step.config.tool_name)?.display_name ?? step.config.tool_name}`,
              operation: "pull_data",
              config: {
                tool_name: step.config.tool_name,
                tool_params: {
                  ...(step.config.params ?? {}),
                  ...((() => { try { const p = JSON.parse(step.config.custom_json as string || "{}"); return typeof p === "object" && p !== null && !Array.isArray(p) ? p : {}; } catch { return {}; } })()),
                },
                signature_display: step.config.signature_display,
              },
              source_text: "",
            };
          case "filter":
            return {
              id: step.id,
              order: idx + 1,
              type: "value" as const,
              label: `Filter: ${step.config.field} ${step.config.operator} ${step.config.value}`,
              operation: "filter",
              config: { field: step.config.field, operator: step.config.operator, value: step.config.value },
              source_text: "",
            };
          case "parse":
            return {
              id: step.id,
              order: idx + 1,
              type: "action" as const,
              label: `Select fields: ${(step.config.fields as string[])?.join(", ")}`,
              operation: "transform",
              config: { pick: step.config.fields },
              source_text: "",
            };
          case "create_view":
            return {
              id: step.id,
              order: idx + 1,
              type: "action" as const,
              label: `Display as ${step.config.format}`,
              operation: "custom",
              config: { instruction: `Display as ${step.config.format}` },
              source_text: "",
            };
          case "create_doc":
            return {
              id: step.id,
              order: idx + 1,
              type: "action" as const,
              label: `Create PDF per record`,
              operation: "generate_doc",
              config: {
                template_id: step.config.template,
                output_format: "pdf",
                per_row: step.config.per_record ?? true,
                filename_pattern: step.config.filename_pattern || "{trip_id}-{name}.pdf",
              },
              source_text: "",
            };
          case "save":
            return {
              id: step.id,
              order: idx + 1,
              type: "action" as const,
              label: `Save as ${step.config.format}`,
              operation: "name_files",
              config: { pattern: step.config.filename_pattern || `{trip_id}-{name}.${step.config.format}` },
              source_text: "",
            };
          default:
            return {
              id: step.id, order: idx + 1, type: "action" as const, label: "Unknown", operation: "custom",
              config: {}, source_text: "",
            };
        }
      });

      // Save workflow
      const readable = buildReadable();
      let workflowId = selectedWorkflowId;

      if (!workflowId) {
        const saveRes = await fetchWithTenant(`/api/agents/${agentId}/workspace/workflows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: workflowName || `Workflow ${new Date().toLocaleDateString()}`,
            natural_input: readable,
            pipeline,
          }),
        });
        if (!saveRes.ok) throw new Error("Failed to save workflow");
        const saved = await saveRes.json();
        workflowId = saved.id;
        setSelectedWorkflowId(workflowId);
      } else {
        await fetchWithTenant(`/api/agents/${agentId}/workspace/workflows/${workflowId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pipeline, natural_input: readable }),
        });
      }

      // Execute
      const res = await fetchWithTenant(`/api/agents/${agentId}/workspace/workflows/${workflowId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Failed to start run");
      const { runId } = await res.json();

      // Poll
      const timer = setInterval(async () => {
        try {
          const pollRes = await fetchWithTenant(`/api/agents/${agentId}/workspace/runs/${runId}`);
          if (pollRes.ok) {
            const run = await pollRes.json();
            setCurrentRun(run);
            if (run.status === "completed" || run.status === "failed") {
              clearInterval(timer);
              setPollTimer(null);
              setRunning(false);
              fetchWorkflows();
            }
          }
        } catch {}
      }, 1500);
      setPollTimer(timer);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run");
      setRunning(false);
    }
  }

  // ── Load saved workflow ──

  async function loadWorkflow(id: string) {
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/workspace/workflows/${id}`);
      if (!res.ok) return;
      const wf = await res.json();
      setSelectedWorkflowId(wf.id);
      setWorkflowName(wf.name ?? "");
      const loaded: WorkflowStep[] = (wf.pipeline ?? []).map((p: any) => {
        let type: StepType = "pull";
        const config: Record<string, unknown> = {};
        switch (p.operation) {
          case "pull_data": type = "pull"; config.tool_name = p.config?.tool_name ?? ""; config.params = p.config?.tool_params ?? {}; if (p.config?.signature_display) config.signature_display = p.config.signature_display; break;
          case "filter": type = "filter"; config.field = p.config?.field ?? ""; config.operator = p.config?.operator ?? "eq"; config.value = p.config?.value ?? ""; break;
          case "transform": type = "parse"; config.fields = p.config?.pick ?? []; break;
          case "generate_doc": type = "create_doc"; config.doc_type = p.config?.output_format ?? "pdf"; config.template = p.config?.template_id ?? ""; config.per_record = p.config?.per_row ?? true; break;
          case "name_files": type = "save"; config.format = "pdf"; config.filename_pattern = p.config?.pattern ?? ""; break;
          default: type = "create_view"; config.format = "table";
        }
        return { id: p.id, type, config };
      });
      setSteps(loaded);

      // Restore last run for this workflow so Preview button stays visible after page refresh
      try {
        const runsRes = await fetchWithTenant(`/api/agents/${agentId}/workspace/runs`);
        if (runsRes.ok) {
          const allRuns = await runsRes.json();
          const lastRun = (allRuns as any[]).find((r: any) => r.workflow_id === id && r.status === "completed");
          if (lastRun) {
            // Fetch full run detail (includes output_data)
            const detailRes = await fetchWithTenant(`/api/agents/${agentId}/workspace/runs/${lastRun.id}`);
            if (detailRes.ok) {
              const detail = await detailRes.json();
              setCurrentRun(detail);
            }
          }
        }
      } catch {}
    } catch {}
  }

  // ── Table helpers ──

  function getDisplayRows(): Record<string, unknown>[] {
    if (!currentRun?.output_data) return [];
    let rows = [...currentRun.output_data];
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      rows = rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(term)));
    }
    if (sortKey) {
      rows.sort((a, b) => {
        const cmp = String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""), undefined, { numeric: true });
        return sortDir === "desc" ? -cmp : cmp;
      });
    }
    return rows;
  }

  function exportCSV() {
    if (!currentRun?.output_data || !currentRun?.output_columns) return;
    const cols = currentRun.output_columns;
    const rows = getDisplayRows();
    const csv = [cols.map((c) => c.label).join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c.key] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `workspace-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  const displayRows = getDisplayRows();
  const pagedRows = displayRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(displayRows.length / PAGE_SIZE);

  // ── Signature display mode from PULL step config ──
  const signatureDisplayMode = (pullStep?.config.signature_display as string) || "link";

  // ── Smart cell renderer (signatures, images, links) ──

  function renderCellValue(key: string, value: unknown): React.ReactNode {
    const strVal = String(value ?? "");
    if (!strVal || strVal === "null" || strVal === "undefined") return <span className="text-gray-300">—</span>;

    // Signature fields: show as link or clickable thumbnail (expands to lightbox)
    if (key.toLowerCase().includes("signature") && /^https?:\/\//i.test(strVal)) {
      if (signatureDisplayMode === "image") {
        return (
          <button
            type="button"
            onClick={() => setExpandedImage(strVal)}
            className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 cursor-pointer"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={strVal}
              alt="signature"
              className="h-10 w-auto rounded border border-gray-200 hover:border-blue-400 hover:shadow transition-all bg-white"
              referrerPolicy="no-referrer"
              onError={(e) => {
                // On CORS/load failure, show link fallback instead of hiding
                const el = e.target as HTMLImageElement;
                el.style.display = "none";
                const fallback = el.nextElementSibling;
                if (fallback) (fallback as HTMLElement).style.display = "inline-flex";
              }}
            />
            <a
              href={strVal}
              target="_blank"
              rel="noopener noreferrer"
              className="items-center gap-1 text-blue-600 hover:text-blue-800 text-[10px] underline hidden"
              onClick={(e) => e.stopPropagation()}
            >
              [open image]
            </a>
          </button>
        );
      }
      // Default: show as link
      return (
        <a href={strVal} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 text-xs">
          <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
          [aws link]
        </a>
      );
    }

    // Image URLs (jpg, png, etc.)
    if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(strVal) && /^https?:\/\//i.test(strVal)) {
      return (
        <a href={strVal} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800">
          <img src={strVal} alt={key} className="h-8 rounded border border-gray-200" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          <span className="text-[10px]">[image]</span>
        </a>
      );
    }

    // AWS S3 / presigned URLs
    if (/^https?:\/\/.*s3.*amazonaws\.com/i.test(strVal) || /^https?:\/\/.*\.s3\./i.test(strVal)) {
      return (
        <a href={strVal} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 text-xs">
          <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
          [aws link]
        </a>
      );
    }

    // Regular URLs
    if (/^https?:\/\//i.test(strVal) && strVal.length > 10) {
      return (
        <a href={strVal} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 text-xs underline truncate max-w-[180px] inline-block">
          {strVal.replace(/^https?:\/\//, "").slice(0, 40)}...
        </a>
      );
    }

    return strVal;
  }

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ── Saved Workflows ── */}
      {workflows.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400 font-bold uppercase">Saved:</span>
          {workflows.map((wf) => (
            <button
              key={wf.id}
              onClick={() => loadWorkflow(wf.id)}
              className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                selectedWorkflowId === wf.id
                  ? "bg-brand-50 border-brand-300 text-brand-700"
                  : "bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100"
              }`}
            >
              {wf.name}
            </button>
          ))}
        </div>
      )}

      {/* ── Step Builder ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <p className="text-xs text-gray-400 uppercase tracking-wider font-bold mb-4">Workflow Builder</p>

        {/* Steps */}
        <div className="space-y-0">
          {steps.map((step, idx) => {
            const typeInfo = STEP_TYPES.find((t) => t.key === step.type)!;
            return (
              <div key={step.id}>
                {/* Connector line */}
                {idx > 0 && (
                  <div className="flex items-center gap-2 py-1 pl-4">
                    <div className="h-6 border-l-2 border-gray-300"></div>
                    <span className="text-[10px] text-gray-300 font-bold uppercase">then</span>
                  </div>
                )}

                {/* Step card */}
                <div className={`border rounded-lg p-4 ${typeInfo.bg}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase ${typeInfo.color} bg-white/60`}>
                        {typeInfo.tag}
                      </span>
                      <span className={`text-sm font-bold ${typeInfo.color}`}>{typeInfo.label}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => testStep(step.id)}
                        disabled={stepTestResults[step.id]?.loading}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border transition-colors bg-white border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50"
                      >
                        {stepTestResults[step.id]?.loading ? (
                          <>
                            <span className="animate-spin inline-block w-2.5 h-2.5 border border-blue-400 border-t-transparent rounded-full" />
                            testing...
                          </>
                        ) : (
                          <>
                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 3l14 9-14 9V3z" /></svg>
                            Test
                          </>
                        )}
                      </button>
                      {savedDefaultFeedback[step.id] ? (
                        <span className="text-[10px] text-green-600 font-medium">Saved as default</span>
                      ) : (
                        <button
                          onClick={() => {
                            saveStepDefault(step.type, step.config);
                            setSavedDefaultFeedback((prev) => ({ ...prev, [step.id]: true }));
                            setTimeout(() => setSavedDefaultFeedback((prev) => { const n = { ...prev }; delete n[step.id]; return n; }), 2000);
                          }}
                          className="text-gray-400 hover:text-green-600 text-xs"
                          title="Save current config as default for new steps of this type"
                        >
                          save default
                        </button>
                      )}
                      {(getSavedStepDefault(step.type) || step.type === "parse") && !savedDefaultFeedback[step.id] && (
                        <button
                          onClick={() => {
                            clearStepDefault(step.type);
                            // For PARSE: reset to smart defaults (not all 250+ raw fields)
                            if (step.type === "parse" && outputFields.length > 0) {
                              const smartFields = outputFields
                                .filter((f) => SMART_DEFAULT_FIELDS.some((sd) => f.key === sd || f.key.endsWith("." + sd)))
                                .map((f) => f.key);
                              updateStep(step.id, { fields: smartFields.length > 0 ? smartFields : outputFields.map((f) => f.key) });
                            }
                          }}
                          className="text-gray-300 hover:text-amber-500 text-xs"
                          title={step.type === "parse" ? "Reset to smart defaults" : "Clear saved default"}
                        >
                          clear default
                        </button>
                      )}
                      <button onClick={() => removeStep(step.id)} className="text-gray-400 hover:text-red-500 text-xs">remove</button>
                    </div>
                  </div>

                  {/* ── PULL config ── */}
                  {step.type === "pull" && (
                    <div className="space-y-3">
                      {/* API endpoint selector */}
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        <span className="text-gray-600">Pull from</span>
                        <SearchSelect
                          value={(step.config.tool_name as string) ?? ""}
                          options={resources.map((r) => ({
                            value: r.tool_name,
                            label: r.display_name,
                            sublabel: r.connector_name,
                          }))}
                          onChange={(v) => {
                            // When tool changes, reset params and probe real API fields
                            updateStep(step.id, { tool_name: v, params: {} });
                            probeToolFields(v);
                          }}
                          placeholder="Select API endpoint..."
                        />
                      </div>

                      {/* Probe status */}
                      {probing && (
                        <div className="flex items-center gap-2 text-xs text-green-600">
                          <div className="animate-spin h-3 w-3 border-2 border-green-500 border-t-transparent rounded-full"></div>
                          Discovering API fields...
                        </div>
                      )}
                      {probedFieldCount > 0 && !probing && (
                        <div className="text-[10px] text-green-600 font-medium">
                          {probedFieldCount} fields discovered from live API
                        </div>
                      )}
                      {probeError && !probing && (
                        <div className="text-[10px] text-amber-600">
                          Could not probe API ({probeError}) — using mapped fields
                        </div>
                      )}

                      {/* Include Signature toggle */}
                      {selectedTool && (
                        <div className="bg-white/50 rounded-lg px-3 py-2 border border-green-200 space-y-2">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-xs font-medium text-gray-700">Include Signature</p>
                              <p className="text-[10px] text-gray-400">Appends ?signature=1 to fetch signed images (AWS links)</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                const params = (step.config.params as Record<string, unknown>) ?? {};
                                const current = params.signature;
                                const newSig = current ? undefined : 1;
                                updateStep(step.id, {
                                  params: { ...params, signature: newSig },
                                  ...(newSig ? {} : { signature_display: undefined }),
                                });

                                // Auto-add/remove signature fields in PARSE step
                                const ps = steps.find((s) => s.type === "parse");
                                if (ps) {
                                  const currentFields = (ps.config.fields as string[]) ?? [];
                                  if (newSig) {
                                    // Add signature fields (payment.signature is the iCabbi key)
                                    const sigFields = ["payment.signature", "signature"];
                                    const toAdd = sigFields.filter((f) => !currentFields.includes(f));
                                    if (toAdd.length > 0) {
                                      updateStep(ps.id, { fields: [...currentFields, ...toAdd] });
                                    }
                                  } else {
                                    // Remove signature fields
                                    updateStep(ps.id, { fields: currentFields.filter((f) => !f.toLowerCase().includes("signature")) });
                                  }
                                }

                                // Re-probe with signature to discover signature fields with real URLs
                                if (newSig && step.config.tool_name) {
                                  probeToolFields(step.config.tool_name as string, { signature: 1 });
                                }
                              }}
                              className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                                (step.config.params as Record<string, unknown>)?.signature ? "bg-green-500" : "bg-gray-300"
                              }`}
                            >
                              <span
                                className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                                  (step.config.params as Record<string, unknown>)?.signature ? "translate-x-5" : "translate-x-0"
                                }`}
                              />
                            </button>
                          </div>
                          {/* Display mode: link or image (only when signature is ON) */}
                          {!!(step.config.params as Record<string, unknown>)?.signature && (
                            <div className="flex items-center gap-3 pl-1">
                              <span className="text-[10px] text-gray-500 font-medium">Display as:</span>
                              {(["link", "image"] as const).map((mode) => {
                                const current = (step.config.signature_display as string) || "link";
                                return (
                                  <button
                                    key={mode}
                                    onClick={() => updateStep(step.id, { signature_display: mode })}
                                    className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                                      current === mode
                                        ? "bg-green-100 border-green-400 text-green-700"
                                        : "bg-white border-gray-200 text-gray-500 hover:border-gray-300"
                                    }`}
                                  >
                                    {mode === "link" ? "[aws link]" : "[jpeg]"}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Dynamic query parameters — add on demand */}
                      {selectedTool && inputFields.length > 0 && (() => {
                        const params = (step.config.params as Record<string, unknown>) ?? {};
                        const paramOps = (step.config.param_operators as Record<string, string>) ?? {};
                        // Active params = fields that have been explicitly added by user
                        const activeParamKeys: string[] = (step.config.active_params as string[]) ?? [];
                        const activeFields = activeParamKeys
                          .map((k) => inputFields.find((f) => f.key === k))
                          .filter((f): f is ToolField => !!f);
                        // Available to add = not yet active
                        const availableFields = inputFields.filter((f) => !activeParamKeys.includes(f.key));

                        const addParam = (fieldKey: string) => {
                          const field = inputFields.find((f) => f.key === fieldKey);
                          if (!field) return;
                          const defaultOp = field.enum_values ? "eq" : field.type === "number" ? "gt" : field.type === "date" ? "gte" : "contains";
                          updateStep(step.id, {
                            active_params: [...activeParamKeys, fieldKey],
                            param_operators: { ...paramOps, [fieldKey]: defaultOp },
                          });
                        };

                        const removeParam = (fieldKey: string) => {
                          const newParams = { ...params };
                          delete newParams[fieldKey];
                          const newOps = { ...paramOps };
                          delete newOps[fieldKey];
                          updateStep(step.id, {
                            active_params: activeParamKeys.filter((k) => k !== fieldKey),
                            params: newParams,
                            param_operators: newOps,
                          });
                        };

                        return (
                          <div className="border-t border-green-200 pt-3 mt-2">
                            {/* Active parameter rows */}
                            {activeFields.length > 0 && (
                              <div className="space-y-2 mb-3">
                                {activeFields.map((field) => {
                                  const val = params[field.key] ?? "";
                                  const fieldOp = paramOps[field.key] ?? (field.type === "number" ? "gt" : field.enum_values ? "eq" : "contains");

                                  const operatorOptions = field.enum_values
                                    ? [{ value: "eq", label: "is" }, { value: "neq", label: "is not" }]
                                    : field.type === "number"
                                    ? [
                                        { value: "eq", label: "is" },
                                        { value: "gt", label: "greater than" },
                                        { value: "gte", label: "at least" },
                                        { value: "lt", label: "less than" },
                                        { value: "lte", label: "at most" },
                                        { value: "neq", label: "is not" },
                                      ]
                                    : field.type === "date"
                                    ? [
                                        { value: "eq", label: "is" },
                                        { value: "gt", label: "after" },
                                        { value: "gte", label: "on or after" },
                                        { value: "lt", label: "before" },
                                        { value: "lte", label: "on or before" },
                                      ]
                                    : [
                                        { value: "contains", label: "contains" },
                                        { value: "eq", label: "is" },
                                        { value: "neq", label: "is not" },
                                        { value: "not_contains", label: "doesn't contain" },
                                        { value: "starts_with", label: "starts with" },
                                        { value: "ends_with", label: "ends with" },
                                      ];

                                  return (
                                    <div key={field.key} className="flex items-center gap-2 text-sm group">
                                      <span className="text-gray-400 text-xs font-medium w-10">Where</span>

                                      <span
                                        className="text-gray-700 text-xs font-semibold bg-green-50 border border-green-200 rounded px-2 py-1 min-w-[120px] cursor-help"
                                        title={`API param: ${field.key}${field.type ? ` (${field.type})` : ""}${field.description ? `\n${field.description}` : ""}`}
                                      >
                                        {field.label}
                                      </span>

                                      <SearchSelect
                                        value={fieldOp}
                                        options={operatorOptions}
                                        onChange={(v) => updateStep(step.id, { param_operators: { ...paramOps, [field.key]: v } })}
                                        className="min-w-[130px]"
                                      />

                                      {field.enum_values ? (
                                        <SearchSelect
                                          value={String(val)}
                                          options={[
                                            { value: "", label: "Any" },
                                            ...field.enum_values.map((v) => ({ value: v, label: v })),
                                          ]}
                                          onChange={(v) => updateStep(step.id, { params: { ...params, [field.key]: v } })}
                                          placeholder="Any"
                                        />
                                      ) : field.type === "number" ? (
                                        <div className="flex items-center gap-1">
                                          <input
                                            type="number"
                                            value={String(val)}
                                            onChange={(e) => updateStep(step.id, { params: { ...params, [field.key]: e.target.value ? Number(e.target.value) : "" } })}
                                            placeholder="Value..."
                                            className="border border-gray-300 rounded-lg px-2 py-1 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-green-400"
                                          />
                                          {field.unit && <span className="text-xs text-gray-400">{field.unit}</span>}
                                        </div>
                                      ) : field.type === "date" ? (
                                        <input
                                          type="date"
                                          value={String(val)}
                                          onChange={(e) => updateStep(step.id, { params: { ...params, [field.key]: e.target.value } })}
                                          className="border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
                                        />
                                      ) : (
                                        <input
                                          type="text"
                                          value={String(val)}
                                          onChange={(e) => updateStep(step.id, { params: { ...params, [field.key]: e.target.value } })}
                                          placeholder={`${field.label}...`}
                                          className="border border-gray-300 rounded-lg px-2 py-1 text-sm flex-1 min-w-[120px] focus:outline-none focus:ring-2 focus:ring-green-400"
                                        />
                                      )}

                                      <button
                                        onClick={() => removeParam(field.key)}
                                        className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all p-0.5"
                                        title="Remove parameter"
                                      >
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {/* + Add Parameter button */}
                            {availableFields.length > 0 && (
                              <div className="relative">
                                <SearchSelect
                                  value=""
                                  options={availableFields.map((f) => ({
                                    value: f.key,
                                    label: f.label,
                                    sublabel: f.type === "number" ? (f.unit ?? "number") : f.type === "date" ? "date" : f.enum_values ? "select" : "text",
                                  }))}
                                  onChange={(v) => addParam(v)}
                                  placeholder="+ Add parameter..."
                                />
                              </div>
                            )}

                            {/* Custom JSON query override */}
                            <details className="mt-2">
                              <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600 select-none">
                                Custom JSON query
                              </summary>
                              <div className="mt-1">
                                <textarea
                                  rows={4}
                                  value={step.config.custom_json ?? ""}
                                  onChange={(e) => {
                                    const raw = e.target.value;
                                    updateStep(step.id, { custom_json: raw });
                                    // Try to parse and merge into params
                                    try {
                                      const parsed = JSON.parse(raw);
                                      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                                        updateStep(step.id, { custom_json: raw, params: { ...params, ...parsed } });
                                      }
                                    } catch {
                                      // Invalid JSON — keep raw text, don't merge
                                    }
                                  }}
                                  placeholder={'{\n  "date_from": "2026-04-01",\n  "limit": 500\n}'}
                                  className="w-full font-mono text-[11px] border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-400 bg-gray-50"
                                  spellCheck={false}
                                />
                                {step.config.custom_json && (() => {
                                  try {
                                    const p = JSON.parse(step.config.custom_json as string);
                                    if (typeof p === "object" && p !== null && !Array.isArray(p)) {
                                      return <span className="text-[10px] text-green-500">Valid JSON — merged into params</span>;
                                    }
                                    return <span className="text-[10px] text-red-400">Must be a JSON object</span>;
                                  } catch {
                                    return <span className="text-[10px] text-red-400">Invalid JSON</span>;
                                  }
                                })()}
                              </div>
                            </details>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* ── FILTER config — uses OUTPUT fields ── */}
                  {step.type === "filter" && (
                    <div className="flex items-center gap-2 flex-wrap text-sm">
                      <span className="text-gray-600">Where</span>

                      {outputFields.length > 0 ? (
                        <SearchSelect
                          value={(step.config.field as string) ?? ""}
                          options={outputFields.map((f) => ({ value: f.key, label: f.label }))}
                          onChange={(v) => updateStep(step.id, { field: v })}
                          placeholder="Select field..."
                        />
                      ) : (
                        <span className="text-xs text-gray-400 italic px-2 py-1 bg-gray-50 rounded border border-dashed border-gray-300">
                          Add a PULL step first to see fields
                        </span>
                      )}

                      <SearchSelect
                        value={(step.config.operator as string) ?? "eq"}
                        options={Object.entries(FILTER_OPERATORS).map(([k, v]) => ({ value: k, label: v }))}
                        onChange={(v) => updateStep(step.id, { operator: v })}
                        placeholder="operator..."
                        className="min-w-[140px]"
                      />

                      {(() => {
                        const field = outputFields.find((f) => f.key === step.config.field);
                        if (field?.enum_values) {
                          return (
                            <SearchSelect
                              value={String(step.config.value ?? "")}
                              options={field.enum_values.map((v) => ({ value: v, label: v }))}
                              onChange={(v) => updateStep(step.id, { value: v })}
                              placeholder="Select..."
                            />
                          );
                        }
                        return (
                          <div className="flex items-center gap-1">
                            <input
                              type={field?.type === "number" ? "number" : "text"}
                              value={String(step.config.value ?? "")}
                              onChange={(e) => updateStep(step.id, { value: field?.type === "number" ? Number(e.target.value) : e.target.value })}
                              placeholder="Value..."
                              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-36 focus:outline-none focus:ring-2 focus:ring-red-300"
                            />
                            {field?.unit && <span className="text-xs text-gray-500">{field.unit}</span>}
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* ── PARSE config — uses OUTPUT fields ── */}
                  {step.type === "parse" && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-gray-600">Select fields to include:</span>
                        {outputFields.length > 0 && (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => updateStep(step.id, { fields: outputFields.map((f) => f.key) })}
                              className="px-2 py-0.5 rounded text-[10px] font-medium border border-gray-200 text-gray-500 hover:bg-gray-50"
                            >
                              All
                            </button>
                            <button
                              onClick={() => updateStep(step.id, { fields: [] })}
                              className="px-2 py-0.5 rounded text-[10px] font-medium border border-gray-200 text-gray-500 hover:bg-gray-50"
                            >
                              None
                            </button>
                            <span className="text-[10px] text-gray-300">|</span>
                            <span className="text-[10px] text-gray-400">{(step.config.fields as string[] ?? []).length}/{outputFields.length} selected</span>
                          </div>
                        )}
                        {probedFields.length === 0 && pullStep?.config.tool_name && (
                          <button
                            onClick={() => probeToolFields(pullStep.config.tool_name as string)}
                            disabled={probing}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-medium border border-orange-300 text-orange-600 hover:bg-orange-50 transition-colors disabled:opacity-50"
                          >
                            {probing ? "Discovering..." : "🔍 Discover All Fields"}
                          </button>
                        )}
                        {probeError && (
                          <span className="text-[10px] text-red-500">{probeError}</span>
                        )}
                      </div>
                      {outputFields.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {outputFields.map((f) => {
                            const selected = (step.config.fields as string[] ?? []).includes(f.key);
                            return (
                              <button
                                key={f.key}
                                onClick={() => {
                                  const current = (step.config.fields as string[]) ?? [];
                                  updateStep(step.id, {
                                    fields: selected ? current.filter((k) => k !== f.key) : [...current, f.key],
                                  });
                                }}
                                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                                  selected
                                    ? "bg-green-500 text-white border-green-600"
                                    : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                                }`}
                                title={f.sample_value ? `Sample: ${f.sample_value}` : f.key}
                              >
                                {f.label}
                                {f.sample_value && !selected && (
                                  <span className="text-[9px] text-gray-400 ml-1 font-normal">({f.sample_value.slice(0, 15)}{f.sample_value.length > 15 ? "..." : ""})</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-400 italic">Add a PULL step first to see available fields</p>
                      )}
                    </div>
                  )}

                  {/* ── CREATE VIEW config ── */}
                  {step.type === "create_view" && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-gray-600">Format:</span>
                      <SearchSelect
                        value={(step.config.format as string) ?? "table"}
                        options={[
                          { value: "table", label: "Table" },
                          { value: "cards", label: "Cards" },
                          { value: "list", label: "List" },
                          { value: "chart", label: "Chart" },
                        ]}
                        onChange={(v) => updateStep(step.id, { format: v })}
                        placeholder="Select format..."
                      />
                    </div>
                  )}

                  {/* ── CREATE DOC config ── */}
                  {step.type === "create_doc" && (
                    <div className="space-y-3">
                      {/* Template selector + create new */}
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        <span className="text-gray-600">Template:</span>
                        <SearchSelect
                          value={(step.config.template as string) ?? ""}
                          options={templates.map((t) => ({
                            value: t.id,
                            label: `${t.name} ${t.base_pdf_key ? "(PDF)" : "(draft)"}`,
                          }))}
                          onChange={(v) => updateStep(step.id, { template: v })}
                          placeholder="Select template..."
                        />
                        <button
                          onClick={async () => {
                            try {
                              const res = await fetchWithTenant("/api/workspace/templates", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  name: `Template ${new Date().toLocaleDateString()}`,
                                  type: "pdf",
                                  content: "",
                                }),
                              });
                              if (!res.ok) throw new Error("Failed to create template");
                              const tmpl = await res.json();
                              await fetchTemplates();
                              updateStep(step.id, { template: tmpl.id });
                              setDesignerTemplateId(tmpl.id);
                            } catch (err) {
                              console.error("Failed to create template:", err);
                              setError(err instanceof Error ? err.message : "Failed to create template");
                            }
                          }}
                          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium rounded-lg"
                        >
                          + New Template
                        </button>
                      </div>

                      {/* Selected template: rename + actions */}
                      {!!step.config.template && (() => {
                        const selectedTmpl = templates.find((t) => t.id === step.config.template);
                        return (
                          <div className="space-y-2">
                            {/* Rename row */}
                            <div className="flex items-center gap-2">
                              {renamingTemplateId === step.config.template ? (
                                <div className="flex items-center gap-1.5">
                                  <input
                                    autoFocus
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onKeyDown={async (e) => {
                                      if (e.key === "Enter" && renameValue.trim()) {
                                        await fetchWithTenant(`/api/workspace/templates/${step.config.template}`, {
                                          method: "PATCH",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ name: renameValue.trim() }),
                                        });
                                        await fetchTemplates();
                                        setRenamingTemplateId(null);
                                      }
                                      if (e.key === "Escape") setRenamingTemplateId(null);
                                    }}
                                    className="border border-purple-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-purple-300 w-48"
                                    placeholder="Template name..."
                                  />
                                  <button
                                    onClick={async () => {
                                      if (!renameValue.trim()) return;
                                      await fetchWithTenant(`/api/workspace/templates/${step.config.template}`, {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ name: renameValue.trim() }),
                                      });
                                      await fetchTemplates();
                                      setRenamingTemplateId(null);
                                    }}
                                    className="text-green-600 hover:text-green-700 text-xs font-medium"
                                  >save</button>
                                  <button onClick={() => setRenamingTemplateId(null)} className="text-gray-400 hover:text-gray-600 text-xs">cancel</button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => { setRenamingTemplateId(step.config.template as string); setRenameValue(selectedTmpl?.name ?? ""); }}
                                  className="text-xs text-gray-500 hover:text-purple-600 flex items-center gap-1"
                                  title="Rename template"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                  {selectedTmpl?.name ?? "Unnamed"}
                                </button>
                              )}
                              <button
                                onClick={() => setDesignerTemplateId(step.config.template as string)}
                                className="px-3 py-1.5 bg-purple-100 hover:bg-purple-200 text-purple-700 text-xs font-medium rounded-lg border border-purple-300"
                              >
                                Open Designer
                              </button>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Per-record toggle */}
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-gray-600">Generate for</span>
                        <SearchSelect
                          value={step.config.per_record ? "each" : "all"}
                          options={[
                            { value: "each", label: "each record (1 PDF per row)" },
                            { value: "all", label: "all records (single PDF)" },
                          ]}
                          onChange={(v) => updateStep(step.id, { per_record: v === "each" })}
                        />
                      </div>

                      {/* Filename pattern with clickable pills */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-gray-600 whitespace-nowrap">Filename:</span>
                          <input
                            value={(step.config.filename_pattern as string) || "{trip_id}-{name}.pdf"}
                            onChange={(e) => updateStep(step.id, { filename_pattern: e.target.value })}
                            className="flex-1 border border-gray-300 rounded-lg px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-purple-300"
                            placeholder="{trip_id}-{name}.pdf"
                          />
                        </div>
                        {outputFields.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {outputFields.slice(0, 20).map((f) => (
                              <button
                                key={f.key}
                                onClick={() => {
                                  const current = (step.config.filename_pattern as string) || "{trip_id}-{name}.pdf";
                                  const cursorTag = `{${f.key}}`;
                                  updateStep(step.id, { filename_pattern: current.replace(/\.pdf$/, "") + "-" + cursorTag + ".pdf" });
                                }}
                                className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-purple-50 text-purple-600 border border-purple-200 hover:bg-purple-100 cursor-pointer"
                                title={`Add {${f.key}} to filename`}
                              >
                                {f.key}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── SAVE config ── */}
                  {step.type === "save" && (
                    <div className="space-y-3">
                      {/* Save target */}
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-gray-600">Save to</span>
                        <SearchSelect
                          value={(step.config.target as string) ?? "downloads"}
                          options={[
                            { value: "downloads", label: "Downloads (browser)" },
                            { value: "google_drive", label: "Google Drive" },
                            { value: "teams", label: "Microsoft Teams / SharePoint" },
                          ]}
                          onChange={(v) => updateStep(step.id, { target: v })}
                        />
                      </div>

                      {/* Format */}
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-gray-600">Format</span>
                        <SearchSelect
                          value={(step.config.format as string) ?? "pdf"}
                          options={[
                            { value: "pdf", label: "PDF" },
                            { value: "docx", label: "Word Doc" },
                            { value: "csv", label: "CSV" },
                            { value: "json", label: "JSON" },
                          ]}
                          onChange={(v) => updateStep(step.id, { format: v })}
                        />
                      </div>

                      {/* File naming pattern */}
                      <div className="space-y-1.5">
                        <span className="text-xs text-gray-500">File naming pattern:</span>
                        <input
                          type="text"
                          value={(step.config.filename_pattern as string) ?? ""}
                          onChange={(e) => updateStep(step.id, { filename_pattern: e.target.value })}
                          placeholder="{company}-{name}-{trip_id}-{date}.pdf"
                          className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-300"
                        />
                        {/* Clickable pills to insert field placeholders */}
                        {outputFields.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {outputFields.slice(0, 25).map((f) => (
                              <button
                                key={f.key}
                                onClick={() => {
                                  const current = (step.config.filename_pattern as string) ?? "";
                                  const ext = `.${(step.config.format as string) || "pdf"}`;
                                  const base = current.endsWith(ext) ? current.slice(0, -ext.length) : current;
                                  updateStep(step.id, { filename_pattern: (base ? base + "-" : "") + `{${f.key}}` + ext });
                                }}
                                className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 cursor-pointer"
                                title={`Add {${f.key}} to filename`}
                              >
                                {f.key}
                              </button>
                            ))}
                            {outputFields.length > 25 && (
                              <span className="text-[9px] text-gray-400 self-center">+{outputFields.length - 25} more</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Preview button — opens PDF viewer (full run) or data preview (test) */}
                      {currentRun?.output_data && currentRun.output_data.length > 0 && (() => {
                        const pdfRows = currentRun.output_data!.filter((r: Record<string, unknown>) => r._pdf_file);
                        const hasPdfs = pdfRows.length > 0 && currentRun.id;
                        const count = hasPdfs ? pdfRows.length : currentRun.output_data!.length;
                        return (
                          <button
                            onClick={() => {
                              if (hasPdfs) {
                                const files = pdfRows.slice(0, 50).map((row: Record<string, unknown>) => ({
                                  filename: String(row._pdf_file),
                                  runId: currentRun.id,
                                }));
                                setPreviewFiles(files);
                                setPreviewIndex(0);
                              } else {
                                // Fallback: show data table preview with generated filenames
                                const pattern = (step.config.filename_pattern as string) || `{trip_id}-{name}.${(step.config.format as string) || "pdf"}`;
                                const files = currentRun.output_data!.slice(0, 50).map((row: Record<string, unknown>) => {
                                  let fn = pattern;
                                  for (const [key, val] of Object.entries(row)) {
                                    fn = fn.replace(`{${key}}`, String(val ?? "").replace(/[^a-zA-Z0-9_\-. ]/g, "").slice(0, 50));
                                  }
                                  fn = fn.replace(/\{[^}]+\}/g, "unknown");
                                  return { filename: fn, runId: "", data: row };
                                });
                                setPreviewFiles(files as any);
                                setPreviewIndex(0);
                              }
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-700 text-xs font-medium rounded-lg border border-amber-300"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                            Preview {Math.min(count, 50)} {hasPdfs ? "PDFs" : "files"}
                          </button>
                        );
                      })()}

                      {/* Download ZIP button — only for SAVE steps with PDF format and a completed run that has PDFs */}
                      {step.type === "save" && (step.config.format as string || "pdf") === "pdf" && currentRun?.id && (() => {
                        const hasPdfFiles = currentRun.output_data?.some((r: Record<string, unknown>) => r._pdf_file);
                        if (!hasPdfFiles) return null;
                        return (
                          <button
                            onClick={async () => {
                              try {
                                const pattern = (step.config.filename_pattern as string) || "";
                                const res = await fetchWithTenant(`/api/agents/${agentId}/workspace/runs/${currentRun.id}/download-zip`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ pattern }),
                                });
                                if (!res.ok) { alert(`Download failed: ${res.status}`); return; }
                                const blob = await res.blob();
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = "SS-Oct25-PDFs.zip";
                                a.click();
                                setTimeout(() => URL.revokeObjectURL(url), 5000);
                              } catch (e) {
                                alert(`Download error: ${e}`);
                              }
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-100 hover:bg-green-200 text-green-700 text-xs font-medium rounded-lg border border-green-300"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                            Download {currentRun.output_data?.filter((r: Record<string, unknown>) => r._pdf_file).length ?? 0} PDFs as ZIP
                          </button>
                        );
                      })()}
                    </div>
                  )}

                  {/* ── Step Test Results ── */}
                  {stepTestResults[step.id] && (
                    <div className="mt-3 border-t border-gray-200/60 pt-3">
                      {stepTestResults[step.id].loading ? (
                        <div className="flex flex-col gap-1.5 text-xs text-blue-600">
                          <div className="flex items-center gap-2">
                            <div className="animate-spin h-3 w-3 border-2 border-blue-500 border-t-transparent rounded-full flex-shrink-0" />
                            <span className="font-medium">
                              {(stepTestResults[step.id].data as Record<string,unknown> | null)?._progress as string ?? "Running pipeline…"}
                            </span>
                          </div>
                          <p className="text-[10px] text-gray-400 pl-5">Large date-range pulls take 3–5 min. Results appear automatically.</p>
                        </div>
                      ) : stepTestResults[step.id].error ? (
                        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-red-600">Test failed</span>
                            <button onClick={() => clearStepTest(step.id)} className="text-[10px] text-gray-400 hover:text-gray-600">dismiss</button>
                          </div>
                          <p className="text-[10px] text-red-500 mt-1">{stepTestResults[step.id].error}</p>
                        </div>
                      ) : (
                        <div className="rounded-lg bg-white border border-gray-200 overflow-hidden">
                          {(() => {
                            const d = stepTestResults[step.id].data as Record<string, unknown> | null;
                            const stepRes = Array.isArray(d?.step_results) ? d.step_results as Array<{ label?: string; status?: string; message?: string; rowCount?: number; duration_ms?: number }> : [];
                            const rows = d?.rows_processed ?? (Array.isArray(d?.output_data) ? (d.output_data as unknown[]).length : 0);
                            const ms = d?.duration_ms ?? "?";
                            const overallStatus = d?.status as string ?? "unknown";
                            const isSuccess = overallStatus === "completed";
                            return (
                              <>
                                <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-200">
                                  <div className="flex items-center gap-2">
                                    <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white ${isSuccess ? "bg-green-500" : "bg-red-500"}`}>
                                      {isSuccess ? "\u2713" : "!"}
                                    </span>
                                    <span className="text-[10px] font-medium text-gray-600">
                                      {String(rows)} rows | {String(ms)}ms
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => toggleStepRaw(step.id)}
                                      className="text-[10px] font-medium text-blue-600 hover:text-blue-800"
                                    >
                                      {stepTestResults[step.id].showRaw ? "Hide Raw" : "View Raw"}
                                    </button>
                                    <button onClick={() => clearStepTest(step.id)} className="text-[10px] text-gray-400 hover:text-gray-600">dismiss</button>
                                  </div>
                                </div>
                                {/* Step-by-step summary */}
                                {stepRes.length > 0 && (
                                  <div className="px-3 py-2 space-y-1 border-b border-gray-100">
                                    {stepRes.map((sr, i) => (
                                      <div key={i} className="flex items-center gap-2 text-[10px]">
                                        <span className={`w-3 h-3 rounded-full flex items-center justify-center text-[7px] font-bold text-white flex-shrink-0 ${
                                          sr.status === "success" ? "bg-green-500" :
                                          sr.status === "error" ? "bg-red-500" :
                                          sr.status === "skipped" ? "bg-yellow-500" :
                                          "bg-gray-400"
                                        }`}>
                                          {sr.status === "success" ? "\u2713" : sr.status === "error" ? "\u2717" : "-"}
                                        </span>
                                        <span className="text-gray-700 font-medium truncate">{sr.label}</span>
                                        {sr.message && <span className="text-gray-400 truncate ml-auto">{sr.message}</span>}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {/* Generated files — clickable PDF previews */}
                                {(() => {
                                  const outputData = Array.isArray(d?.output_data) ? d.output_data as Record<string, unknown>[] : [];
                                  const pdfFiles = outputData.filter((r) => r._pdf_file);
                                  const testRunId = d?.run_id as string | undefined;
                                  if (pdfFiles.length === 0) return null;
                                  return (
                                    <PdfFileList
                                      pdfFiles={pdfFiles}
                                      runId={testRunId}
                                      totalCount={pdfFiles.length}
                                    />
                                  );
                                })()}
                                {stepTestResults[step.id].showRaw && (
                                  <div className="max-h-64 overflow-auto">
                                    <pre className="text-[10px] leading-relaxed text-gray-700 p-3 font-mono whitespace-pre-wrap break-all">
                                      {JSON.stringify(d, null, 2)}
                                    </pre>
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* ── Add Step Button ── */}
          <div className="pt-2">
            {steps.length > 0 && !addingStep && (
              <div className="flex items-center gap-2 pl-4 pb-2">
                <div className="h-4 border-l-2 border-gray-300"></div>
              </div>
            )}
            {addingStep ? (
              <div className="border border-dashed border-gray-300 rounded-lg p-3 bg-gray-50">
                <p className="text-xs text-gray-500 font-medium mb-2">Choose step type:</p>
                <div className="flex flex-wrap gap-2">
                  {STEP_TYPES
                    .filter((t) => {
                      // Only show PULL if no pull step yet
                      if (t.key === "pull" && steps.some((s) => s.type === "pull")) return false;
                      // Only show filter/parse/view/doc/save after pull
                      if (t.key !== "pull" && !steps.some((s) => s.type === "pull")) return false;
                      return true;
                    })
                    .map((t) => (
                      <button
                        key={t.key}
                        onClick={() => addStep(t.key)}
                        className={`px-3 py-2 rounded-lg text-xs font-bold border transition-colors ${t.bg} ${t.color} hover:opacity-80`}
                      >
                        <div>{t.label}</div>
                        <div className="text-[10px] font-normal opacity-70">{t.description}</div>
                      </button>
                    ))}
                  <button onClick={() => setAddingStep(false)} className="px-3 py-2 text-xs text-gray-400 hover:text-gray-600">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingStep(true)}
                className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-sm font-medium text-gray-400 hover:text-brand-600 hover:border-brand-300 transition-colors"
              >
                + Add Step
              </button>
            )}
          </div>
        </div>

        {/* ── Readable summary ── */}
        {steps.length > 0 && (
          <div className="mt-4 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
            <p className="text-xs text-gray-400 font-bold uppercase mb-1">Reads as:</p>
            <p className="text-sm text-gray-700 italic">{buildReadable()}</p>
          </div>
        )}

        {/* ── Error ── */}
        {error && (
          <div className="mt-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {/* ── Run + Save ── */}
        {steps.length > 0 && (
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleRun}
              disabled={running || !steps.some((s) => s.type === "pull" && s.config.tool_name)}
              className="px-6 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-bold rounded-lg disabled:opacity-50 transition-colors"
            >
              {running ? "Running..." : "Run Workflow"}
            </button>

            <div className="flex items-center gap-2 ml-auto">
              <input
                type="text"
                value={workflowName}
                onChange={(e) => setWorkflowName(e.target.value)}
                placeholder="Name this workflow..."
                className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                onClick={async () => {
                  const readable = buildReadable();
                  const pipeline = steps.map((s, i) => ({ id: s.id, order: i, type: "action", label: s.type, operation: s.type, config: s.config, source_text: "" }));
                  if (selectedWorkflowId) {
                    await fetchWithTenant(`/api/agents/${agentId}/workspace/workflows/${selectedWorkflowId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: workflowName, pipeline, natural_input: readable }),
                    });
                  } else {
                    const res = await fetchWithTenant(`/api/agents/${agentId}/workspace/workflows`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: workflowName || "Untitled", natural_input: readable, pipeline }),
                    });
                    if (res.ok) setSelectedWorkflowId((await res.json()).id);
                  }
                  fetchWorkflows();
                }}
                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium rounded-lg"
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Execution Progress ── */}
      {(running || currentRun?.step_results?.length) && currentRun && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider font-bold mb-3">Execution</p>
          <div className="space-y-1.5">
            {(currentRun.step_results ?? []).map((sr, idx) => (
              <div key={idx} className="flex items-center gap-3 text-sm">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${
                  sr.status === "success" ? "bg-green-500" : sr.status === "error" ? "bg-red-500" : "bg-gray-300"
                }`}>
                  {sr.status === "success" ? "\u2713" : sr.status === "error" ? "!" : idx + 1}
                </span>
                <span className="text-gray-700 font-medium flex-1">{sr.label}</span>
                <span className="text-xs text-gray-400">{sr.rowCount} rows</span>
                <span className="text-xs text-gray-300">{sr.duration_ms}ms</span>
                {sr.message && <span className="text-xs text-gray-400">{sr.message}</span>}
                {sr.error && <span className="text-xs text-red-500">{sr.error}</span>}
              </div>
            ))}
            {running && (
              <div className="flex items-center gap-2 pt-1">
                <div className="animate-spin h-4 w-4 border-2 border-blue-500 border-t-transparent rounded-full"></div>
                <span className="text-sm text-blue-600">Processing...</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Results Table ── */}
      {currentRun?.status === "completed" && currentRun.output_data && currentRun.output_columns && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-400 uppercase tracking-wider font-bold">
              Results: {displayRows.length} rows
              {currentRun.duration_ms && <span> | {(currentRun.duration_ms / 1000).toFixed(1)}s</span>}
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(0); }}
                placeholder="Search..."
                className="border border-gray-300 rounded-lg px-2 py-1 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button onClick={exportCSV} className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium rounded-lg">
                Export CSV
              </button>
            </div>
          </div>

          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  {currentRun.output_columns.map((col) => (
                    <th
                      key={col.key}
                      onClick={() => { setSortKey(col.key); setSortDir(sortKey === col.key && sortDir === "asc" ? "desc" : "asc"); setCurrentPage(0); }}
                      className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider border-b cursor-pointer hover:bg-gray-100"
                    >
                      {col.label} {sortKey === col.key && (sortDir === "asc" ? "\u25B2" : "\u25BC")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pagedRows.map((row, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    {currentRun.output_columns!.map((col) => (
                      <td key={col.key} className={`px-3 py-2 text-gray-700 whitespace-nowrap ${
                        col.key.toLowerCase().includes("signature") && signatureDisplayMode === "image"
                          ? "" : "max-w-[300px] truncate"
                      }`}>
                        {renderCellValue(col.key, row[col.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>Page {currentPage + 1} of {totalPages} ({displayRows.length} rows)</span>
              <div className="flex gap-1">
                <button disabled={currentPage === 0} onClick={() => setCurrentPage(currentPage - 1)} className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 disabled:opacity-30">Prev</button>
                <button disabled={currentPage >= totalPages - 1} onClick={() => setCurrentPage(currentPage + 1)} className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 disabled:opacity-30">Next</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Error ── */}
      {currentRun?.status === "failed" && (
        <div className="bg-red-50 rounded-xl border border-red-200 p-4">
          <p className="text-sm font-medium text-red-700">Workflow failed</p>
          <p className="text-sm text-red-600">{currentRun.error}</p>
        </div>
      )}

      {/* ── AI Notes ── */}
      {currentRun?.ai_notes && (
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-5">
          <p className="text-xs text-amber-600 uppercase tracking-wider font-bold mb-2">AI Notes</p>
          <pre className="text-sm text-amber-800 whitespace-pre-wrap font-sans">{currentRun.ai_notes}</pre>
        </div>
      )}

      {/* ── Template Designer Modal ── */}
      {designerTemplateId && (() => {
        // Build sample row: prefer first real result row, fall back to sample_value from field defs
        const sampleRow: Record<string, unknown> = currentRun?.output_data?.[0]
          ? { ...currentRun.output_data[0] }
          : outputFields.reduce((acc, f) => { if (f.sample_value) acc[f.key] = f.sample_value; return acc; }, {} as Record<string, unknown>);
        return (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"><div className="animate-spin h-8 w-8 border-3 border-green-500 border-t-transparent rounded-full" /></div>}>
          <TemplateDesigner
            templateId={designerTemplateId}
            availableFields={
              // Only show fields that were selected in the PARSE step (not all 80+ raw API fields)
              (selectedFields.length > 0
                ? outputFields.filter((f) => selectedFields.includes(f.key))
                : outputFields
              ).map((f) => ({ key: f.key, label: f.label }))
            }
            sampleRow={sampleRow}
            onSave={() => { setDesignerTemplateId(null); fetchTemplates(); }}
            onClose={() => setDesignerTemplateId(null)}
          />
        </Suspense>
        );
      })()}

      {/* ── File Preview Modal ── */}
      {/* ── PDF Preview Modal ── */}
      {previewFiles && previewFiles.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setPreviewFiles(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setPreviewIndex((i) => Math.max(0, i - 1));
            else if (e.key === "ArrowRight") setPreviewIndex((i) => Math.min(previewFiles.length - 1, i + 1));
            else if (e.key === "Escape") setPreviewFiles(null);
          }}
          tabIndex={0}
          role="dialog"
        >
          <div className="bg-white rounded-xl shadow-2xl w-[90vw] max-w-[900px] h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 shrink-0">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-bold text-gray-800">PDF Preview</h3>
                <span className="text-xs text-gray-400">{previewIndex + 1} of {previewFiles.length}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 max-w-[300px] truncate">
                  {previewFiles[previewIndex].filename}
                </span>
                <button onClick={() => setPreviewFiles(null)} className="text-gray-400 hover:text-gray-600 ml-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>

            {/* PDF iframe or data table */}
            <div className="flex-1 relative bg-gray-100">
              {previewFiles[previewIndex].runId ? (
                // PDF mode: render in iframe
                previewBlobUrls[previewIndex] ? (
                  <iframe
                    key={previewBlobUrls[previewIndex]}
                    src={previewBlobUrls[previewIndex]}
                    className="absolute inset-0 w-full h-full border-0"
                    title={previewFiles[previewIndex].filename}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="animate-spin h-8 w-8 border-3 border-amber-500 border-t-transparent rounded-full" />
                      <span className="text-sm text-gray-500">Loading PDF...</span>
                    </div>
                  </div>
                )
              ) : (
                // Data table fallback
                <div className="absolute inset-0 overflow-y-auto p-5">
                  <table className="w-full text-xs">
                    <tbody>
                      {previewFiles[previewIndex].data && Object.entries(previewFiles[previewIndex].data!).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "").slice(0, 40).map(([key, val]) => (
                        <tr key={key} className="border-b border-gray-200">
                          <td className="py-2 pr-3 text-gray-500 font-medium whitespace-nowrap align-top">{key}</td>
                          <td className="py-2 text-gray-800 break-all">{typeof val === "string" && val.startsWith("http") ? <a href={val} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">{val}</a> : String(val).slice(0, 200)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Left arrow overlay */}
              {previewIndex > 0 && (
                <button
                  onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))}
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center shadow-lg transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" /></svg>
                </button>
              )}

              {/* Right arrow overlay */}
              {previewIndex < previewFiles.length - 1 && (
                <button
                  onClick={() => setPreviewIndex((i) => Math.min(previewFiles.length - 1, i + 1))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center shadow-lg transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
                </button>
              )}
            </div>

            {/* Bottom nav dots */}
            <div className="flex items-center justify-center gap-1.5 px-5 py-2.5 border-t border-gray-200 bg-gray-50 shrink-0">
              {previewFiles.slice(0, 20).map((_, i) => (
                <button
                  key={i}
                  onClick={() => setPreviewIndex(i)}
                  className={`w-2.5 h-2.5 rounded-full transition-colors ${i === previewIndex ? "bg-amber-500 scale-125" : "bg-gray-300 hover:bg-gray-400"}`}
                />
              ))}
              {previewFiles.length > 20 && <span className="text-[9px] text-gray-400 ml-1">+{previewFiles.length - 20}</span>}
            </div>
          </div>
        </div>
      )}

      {/* ── Signature Lightbox ── */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setExpandedImage(null)}
        >
          <div
            className="relative bg-white rounded-xl shadow-2xl p-4 max-w-lg max-h-[80vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setExpandedImage(null)}
              className="absolute -top-3 -right-3 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center text-gray-500 hover:text-gray-800 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
            <img
              src={expandedImage}
              alt="Signature"
              className="max-w-full max-h-[70vh] rounded-lg"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-gray-400">Signature</span>
              <a
                href={expandedImage}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:text-blue-800 underline"
              >
                Open in new tab
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
