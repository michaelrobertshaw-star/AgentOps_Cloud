"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { flushSync } from "react-dom";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

interface TemplateDesignerProps {
  templateId: string;
  availableFields: Array<{ key: string; label: string }>;
  sampleRow?: Record<string, unknown>;
  onSave: () => void;
  onClose: () => void;
}

/**
 * Normalize a raw value to a pdfme-compatible image content string.
 * pdfme image fields require a base64 data URI (data:image/...;base64,...).
 * - Already a data URI → pass through
 * - Raw base64 (no spaces, no protocol) → prepend data:image/jpeg;base64,
 * - URL (http/https) → return empty string (can't fetch synchronously in designer)
 * - Anything else → empty string (pdfme shows placeholder)
 */
function toImageContent(val: unknown): string {
  if (val === undefined || val === null) return "";
  const str = String(val).trim();
  if (!str) return "";
  if (str.startsWith("data:")) return str; // already a data URI
  if (str.startsWith("http://") || str.startsWith("https://")) return ""; // URL — not usable as inline content
  // Treat as raw base64
  return `data:image/jpeg;base64,${str}`;
}

/** Build pdfme sampledata from current schema field names, mappings, and real row data */
function buildSampledata(
  schemas: unknown,
  fieldMappings: Record<string, string>,
  sampleRow: Record<string, unknown>,
): Record<string, string>[] {
  const data: Record<string, string> = {};
  const pages = Array.isArray(schemas) ? schemas : [];
  for (const page of pages) {
    const fields = Array.isArray(page) ? page : Object.values(page as object);
    for (const field of fields) {
      const name = (field as any)?.name;
      if (!name) continue;
      const fieldType = (field as any)?.type;
      const mappedKey = fieldMappings[name];
      const val = mappedKey !== undefined ? sampleRow[mappedKey] : undefined;
      if (val !== undefined && val !== null) {
        data[name] = fieldType === "image" ? toImageContent(val) : String(val);
      } else {
        data[name] = fieldType === "image" ? "" : `{${name}}`;
      }
    }
  }
  return [data];
}

/**
 * Inject real sample values into each field's `content` property.
 * pdfme Designer uses `content` for the visual preview (not `sampledata`).
 * `sampledata` is only used by @pdfme/generator at generation time.
 */
function injectSampleValues(
  schemas: any[][],
  fieldMappings: Record<string, string>,
  sampleRow: Record<string, unknown>,
): any[][] {
  return schemas.map((page: any) => {
    const fields = Array.isArray(page) ? page : Object.values(page as object);
    return fields.map((field: any) => {
      if (!field?.name) return field;
      const mappedKey = fieldMappings[field.name];
      const val = mappedKey !== undefined ? sampleRow[mappedKey] : undefined;
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        const content =
          field.type === "image" ? toImageContent(val) : String(val);
        return { ...field, content };
      }
      return field;
    });
  });
}

/**
 * pdfme Template Designer — embedded in a full-screen modal.
 * Allows the user to:
 * 1. Upload a base PDF
 * 2. Place text/image fields on the PDF (drag & drop)
 * 3. Name fields that map to data columns
 * 4. Save the schema + field mappings
 */
export default function TemplateDesigner({
  templateId,
  availableFields,
  sampleRow = {},
  onSave,
  onClose,
}: TemplateDesignerProps) {
  const designerContainerRef = useRef<HTMLDivElement>(null);
  const designerRef = useRef<any>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSampledataUpdateRef = useRef(false); // prevents sampledata updates from triggering auto-save
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [basePdfUploaded, setBasePdfUploaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [fieldMappings, setFieldMappings] = useState<Record<string, string>>({});
  const [schemaFields, setSchemaFields] = useState<string[]>([]);
  const [draggedField, setDraggedField] = useState<{ key: string; label: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  // resolvedSampleRow: same as sampleRow but URL image values are fetched → base64 data URIs
  const [resolvedSampleRow, setResolvedSampleRow] = useState<Record<string, unknown>>(sampleRow);

  // When sampleRow changes, resolve any URL-based image values to base64 data URIs.
  // This lets the designer preview render actual images from remote URLs.
  useEffect(() => {
    let cancelled = false;
    async function resolveSampleRow() {
      const resolved: Record<string, unknown> = { ...sampleRow };
      await Promise.all(
        Object.entries(sampleRow).map(async ([key, val]) => {
          const str = val != null ? String(val).trim() : "";
          if (str.startsWith("http://") || str.startsWith("https://")) {
            try {
              const res = await fetch(str);
              const buf = await res.arrayBuffer();
              const mime = res.headers.get("content-type") || "image/jpeg";
              const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
              if (!cancelled) resolved[key] = `data:${mime};base64,${b64}`;
            } catch {
              // leave as-is if fetch fails
            }
          }
        }),
      );
      if (!cancelled) setResolvedSampleRow(resolved);
    }
    void resolveSampleRow();
    return () => { cancelled = true; };
  }, [sampleRow]);

  // Load template data
  useEffect(() => {
    async function loadTemplate() {
      try {
        const res = await fetchWithTenant(`/api/workspace/templates/${templateId}`);
        if (!res.ok) throw new Error("Failed to load template");
        const tmpl = await res.json();
        // Flush all state + set loading=false together so the designer div
        // is in the DOM (not the spinner) before initDesigner runs
        flushSync(() => {
          setBasePdfUploaded(!!tmpl.base_pdf_key);
          setFieldMappings(tmpl.field_mappings ?? {});
          if (tmpl.pdfme_schema) {
            setSchemaFields(extractFieldNames(tmpl.pdfme_schema));
          }
          setLoading(false);
        });

        // Initialize pdfme designer if base PDF exists — pass mappings explicitly to avoid stale closure
        if (tmpl.base_pdf_key) {
          await initDesigner(tmpl, tmpl.field_mappings ?? {});
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Load failed");
        setLoading(false);
      }
    }
    loadTemplate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  function extractFieldNames(schema: unknown): string[] {
    if (!Array.isArray(schema)) return [];
    const names: string[] = [];
    for (const page of schema) {
      if (Array.isArray(page)) {
        for (const field of page) {
          if (field?.name) names.push(field.name);
        }
      } else if (typeof page === "object" && page) {
        for (const val of Object.values(page)) {
          if (typeof val === "object" && val && "name" in (val as any)) {
            names.push((val as any).name);
          }
        }
      }
    }
    return names;
  }

  async function initDesigner(tmpl: any, initialMappings?: Record<string, string>) {
    if (!designerContainerRef.current) return;

    try {
      // Dynamic import of pdfme/ui (client-side only)
      const { Designer } = await import("@pdfme/ui");
      const { text, image } = await import("@pdfme/schemas");

      // Fetch base PDF
      const pdfRes = await fetchWithTenant(`/api/workspace/templates/${templateId}/base-pdf`);
      if (!pdfRes.ok) throw new Error("Failed to load base PDF");
      const pdfBlob = await pdfRes.blob();
      const pdfArrayBuffer = await pdfBlob.arrayBuffer();
      const basePdf = new Uint8Array(pdfArrayBuffer);

      // Build template
      const schemas = tmpl.pdfme_schema ?? [[
        {
          name: "field_1",
          type: "text",
          position: { x: 20, y: 20 },
          width: 100,
          height: 10,
          fontSize: 12,
        },
      ]];

      // Inject real values into field content so Designer shows them immediately
      const activeMappings = initialMappings ?? fieldMappings;
      const enrichedSchemas = injectSampleValues(schemas, activeMappings, resolvedSampleRow);

      const template = {
        basePdf,
        schemas: enrichedSchemas,
        sampledata: buildSampledata(enrichedSchemas, activeMappings, resolvedSampleRow),
      };

      // Clear any existing designer
      if (designerRef.current) {
        designerRef.current.destroy();
      }

      designerRef.current = new Designer({
        domContainer: designerContainerRef.current,
        template,
        plugins: { text, image },
      });

      // Listen for template changes — track fields + auto-save schema to DB
      designerRef.current.onChangeTemplate((t: any) => {
        const fields = extractFieldNames(t.schemas);
        setSchemaFields(fields);

        // Skip auto-save when we triggered the change ourselves (sampledata update)
        if (isSampledataUpdateRef.current) return;

        // Debounced auto-save: 800ms after last change (captures color, font, position, etc.)
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
        setAutoSaveStatus("saving");
        autoSaveTimerRef.current = setTimeout(async () => {
          try {
            await fetchWithTenant(`/api/workspace/templates/${templateId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pdfme_schema: t.schemas }),
            });
            setAutoSaveStatus("saved");
            setTimeout(() => setAutoSaveStatus("idle"), 2000);
          } catch {
            setAutoSaveStatus("error");
          }
        }, 800);
      });
    } catch (err) {
      console.error("pdfme designer init failed:", err);
      setError(`Designer failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Live preview: inject real values into field `content` AND sampledata whenever mappings change.
  // pdfme Designer renders from `content`; sampledata is used by the generator.
  // Use loop guard so this doesn't trigger auto-save.
  useEffect(() => {
    if (!designerRef.current) return;
    isSampledataUpdateRef.current = true;
    const tmpl = designerRef.current.getTemplate();
    const updatedSchemas = injectSampleValues(tmpl.schemas, fieldMappings, resolvedSampleRow);
    designerRef.current.updateTemplate({
      ...tmpl,
      schemas: updatedSchemas,
      sampledata: buildSampledata(updatedSchemas, fieldMappings, resolvedSampleRow),
    });
    setTimeout(() => { isSampledataUpdateRef.current = false; }, 50);
  }, [fieldMappings, resolvedSampleRow]);

  // Upload base PDF
  async function handlePdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);

    try {
      const arrayBuffer = await file.arrayBuffer();

      const res = await fetchWithTenant(`/api/workspace/templates/${templateId}/upload-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: arrayBuffer,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`Upload failed (${res.status}): ${errBody?.error ?? errBody?.raw ?? "unknown error"}`);
      }

      // Reload template first, then flush state + loading=false together
      // so the designer div is in the DOM (not the spinner) before initDesigner
      const tmplRes = await fetchWithTenant(`/api/workspace/templates/${templateId}`);
      const tmpl = await tmplRes.json();
      flushSync(() => {
        setBasePdfUploaded(true);
        setLoading(false);
      });
      await initDesigner(tmpl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setLoading(false);
    }
  }

  // Save schema + field mappings
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      let pdfmeSchema = null;
      if (designerRef.current) {
        const template = designerRef.current.getTemplate();
        pdfmeSchema = template.schemas;
      }

      await fetchWithTenant(`/api/workspace/templates/${templateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdfme_schema: pdfmeSchema,
          field_mappings: fieldMappings,
        }),
      });

      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [templateId, fieldMappings, onSave]);

  /** Handles a column pill being dropped onto the PDF canvas */
  function handleColumnDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (!draggedField || !designerRef.current) return;

    const container = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - container.left) / container.width;
    const relY = (e.clientY - container.top) / container.height;
    // Approximate PDF mm coords (A4: 210 × 297mm, pdfme has ~10mm internal margins)
    const pdfX = Math.max(5, Math.min(175, relX * 210 - 5));
    const pdfY = Math.max(5, Math.min(280, relY * 297));

    // Unique field name from column key
    const existingNames = new Set(schemaFields);
    let fieldName = draggedField.key.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
    if (!fieldName) fieldName = "field";
    let candidate = fieldName;
    let n = 2;
    while (existingNames.has(candidate)) { candidate = `${fieldName}_${n++}`; }
    fieldName = candidate;

    // Insert into pdfme template — set `content` to real value so it shows immediately in preview.
    // Detect image fields: if the resolved value looks like a data URI or base64, use image type.
    const tmpl = designerRef.current.getTemplate();
    const realVal = resolvedSampleRow[draggedField.key];
    const realStr = realVal !== undefined && realVal !== null ? String(realVal).trim() : "";
    const isImageValue =
      realStr.startsWith("data:image") ||
      (realStr.length > 100 && !realStr.includes(" ") && !realStr.startsWith("http"));
    const fieldType = isImageValue ? "image" : "text";
    const previewContent = isImageValue
      ? toImageContent(realVal)
      : realStr || draggedField.label;
    const newField = isImageValue
      ? { name: fieldName, type: "image", position: { x: pdfX, y: pdfY }, width: 40, height: 40, content: previewContent }
      : { name: fieldName, type: "text", position: { x: pdfX, y: pdfY }, width: 60, height: 8, fontSize: 10, fontColor: "#000000", content: previewContent };
    const pages = tmpl.schemas.length > 0 ? [...tmpl.schemas] : [[]];
    pages[0] = Array.isArray(pages[0]) ? [...(pages[0] as any[]), newField] : [...Object.values(pages[0] as object), newField];

    const newMappings = { ...fieldMappings, [fieldName]: draggedField.key };
    setFieldMappings(newMappings);
    const newSchemas = pages;
    setSchemaFields(extractFieldNames(newSchemas));

    const enrichedSchemas = injectSampleValues(newSchemas, newMappings, resolvedSampleRow);
    designerRef.current.updateTemplate({
      ...tmpl,
      schemas: enrichedSchemas,
      sampledata: buildSampledata(enrichedSchemas, newMappings, resolvedSampleRow),
    });
    setDraggedField(null);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
      <div className="bg-white rounded-xl shadow-2xl w-[95vw] h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-bold text-gray-800">Template Designer</h2>
          <div className="flex items-center gap-3">
            {/* Auto-save status */}
            {autoSaveStatus === "saving" && (
              <span className="flex items-center gap-1.5 text-xs text-gray-500">
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                Auto-saving…
              </span>
            )}
            {autoSaveStatus === "saved" && (
              <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/>
                </svg>
                Saved
              </span>
            )}
            {autoSaveStatus === "error" && (
              <span className="text-xs text-red-500">Save failed</span>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save & Close"}
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium rounded-lg"
            >
              Close
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          {/* Left: PDF Designer Canvas */}
          <div className="flex-1 flex flex-col relative">
            {!basePdfUploaded ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center space-y-4">
                  <div className="w-20 h-20 mx-auto bg-gray-100 rounded-2xl flex items-center justify-center">
                    <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-lg font-medium text-gray-700">Upload your PDF template</p>
                    <p className="text-sm text-gray-400 mt-1">This will be the base document. You&apos;ll place data fields on top of it.</p>
                  </div>
                  <label className="inline-flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg cursor-pointer transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Choose PDF File
                    <input type="file" accept=".pdf" onChange={handlePdfUpload} className="hidden" />
                  </label>
                </div>
              </div>
            ) : loading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="animate-spin h-8 w-8 border-3 border-green-500 border-t-transparent rounded-full" />
              </div>
            ) : (
              // Drop zone wraps pdfme so columns can be dragged onto the PDF
              <div
                className="flex-1 w-full relative"
                style={{ minHeight: 0 }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleColumnDrop}
              >
                {/* Drop overlay hint */}
                {isDragOver && draggedField && (
                  <div className="absolute inset-0 z-10 pointer-events-none border-2 border-dashed border-green-500 rounded flex items-center justify-center bg-green-50/30">
                    <div className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium shadow-lg">
                      Drop to add <strong>{draggedField.label}</strong> field
                    </div>
                  </div>
                )}
                <div ref={designerContainerRef} className="w-full h-full" />
              </div>
            )}
          </div>

          {/* Right: Data Columns + Mapped Fields Panel */}
          {basePdfUploaded && (
            <div className="w-72 border-l border-gray-200 bg-gray-50 flex flex-col overflow-hidden">

              {/* Section 1: Mapped fields (only what's been linked) */}
              <div className="p-4 border-b border-gray-200 overflow-y-auto" style={{ maxHeight: "45%" }}>
                <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                  Mapped Fields {schemaFields.filter(f => fieldMappings[f]).length > 0 && `(${schemaFields.filter(f => fieldMappings[f]).length})`}
                </h3>
                {schemaFields.filter(f => fieldMappings[f]).length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-4 text-center">
                    <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                    </svg>
                    <p className="text-[11px] text-gray-400">Drag columns onto the PDF<br/>to create mapped fields</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {schemaFields.filter(f => fieldMappings[f]).map((fieldName) => {
                      const mappedCol = availableFields.find(f => f.key === fieldMappings[fieldName]);
                      return (
                        <div key={fieldName} className="flex items-center gap-1.5 bg-white border border-gray-200 rounded-lg px-2 py-1.5 group">
                          <div className="flex-1 min-w-0">
                            <div className="text-[10px] font-medium text-gray-700 truncate">{mappedCol?.label ?? fieldMappings[fieldName]}</div>
                            <div className="text-[9px] text-gray-400 truncate">→ field: {fieldName}</div>
                          </div>
                          <button
                            onClick={() => setFieldMappings(prev => { const n = {...prev}; delete n[fieldName]; return n; })}
                            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-opacity flex-shrink-0"
                            title="Remove mapping"
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
              </div>

              {/* Section 2: Draggable data columns */}
              <div className="flex-1 p-4 overflow-y-auto">
                <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Data Columns</h3>
                <p className="text-[10px] text-gray-400 mb-3">Drag onto PDF to place a field</p>
                <div className="flex flex-wrap gap-1.5">
                  {availableFields.map((f) => {
                    const isMapped = Object.values(fieldMappings).includes(f.key);
                    return (
                      <div
                        key={f.key}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData("text/plain", f.key); setDraggedField(f); }}
                        onDragEnd={() => setDraggedField(null)}
                        className={`px-2 py-1 rounded-md text-[10px] font-medium cursor-grab active:cursor-grabbing select-none transition-colors ${
                          isMapped
                            ? "bg-green-100 border border-green-300 text-green-700"
                            : "bg-white border border-gray-200 text-gray-600 hover:border-green-400 hover:text-green-700 hover:bg-green-50"
                        }`}
                        title={`${f.key}${isMapped ? " (mapped)" : " — drag onto PDF"}`}
                      >
                        {f.label}
                        {isMapped && <span className="ml-1 text-green-500">✓</span>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Footer: replace PDF */}
              <div className="p-3 border-t border-gray-200">
                <label className="inline-flex items-center gap-1 px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs font-medium rounded-lg cursor-pointer w-full justify-center">
                  Replace Base PDF
                  <input type="file" accept=".pdf" onChange={handlePdfUpload} className="hidden" />
                </label>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
