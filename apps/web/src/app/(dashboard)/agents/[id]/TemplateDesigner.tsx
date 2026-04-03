"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { flushSync } from "react-dom";
import { fetchWithTenant } from "@/lib/fetchWithTenant";
// SignatureOverlay removed — signature fields now use simple column mapping (no drag overlay)

interface TemplateDesignerProps {
  templateId: string;
  availableFields: Array<{ key: string; label: string }>;
  sampleRow?: Record<string, unknown>;
  onSave: () => void;
  onClose: () => void;
}

interface PdfFormField {
  name: string;
  type: "text" | "checkbox" | "dropdown" | "radio" | "signature" | "unknown";
  rect?: { x: number; y: number; width: number; height: number };
  pageIndex?: number;
  pageWidth?: number;
  pageHeight?: number;
  options?: string[];
}

// ── Shared helpers ──────────────────────────────────────────────

function toImageContent(val: unknown): string {
  if (val === undefined || val === null) return "";
  const str = String(val).trim();
  if (!str) return "";
  if (str.startsWith("data:")) return str;
  if (str.startsWith("http://") || str.startsWith("https://")) return "";
  return `data:image/jpeg;base64,${str}`;
}

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

function injectSampleValues(
  schemas: unknown,
  fieldMappings: Record<string, string>,
  sampleRow: Record<string, unknown>,
): unknown {
  if (!Array.isArray(schemas)) return schemas;
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
 * AI auto-mapping: fuzzy-match PDF form field names to data column names.
 * Normalizes both sides (lowercase, strip underscores/dots/spaces) and finds best matches.
 */
function autoMapFields(
  formFields: PdfFormField[],
  dataColumns: Array<{ key: string; label: string }>,
): Record<string, string> {
  const mappings: Record<string, string> = {};
  // Strip possessives (Member's → Member), punctuation, whitespace, underscores
  const normalize = (s: string) =>
    s.toLowerCase()
      .replace(/'s\b/g, "") // strip possessives
      .replace(/[_.\s\-\/()#]+/g, "")
      .replace(/[']/g, "");

  // Common PDF field name → data column aliases
  const aliases: Record<string, string[]> = {
    membername: ["name", "passengername", "passenger_name", "membername"],
    membersname: ["name", "passengername", "passenger_name"],
    drivername: ["drivername", "driver_name", "driver.name"],
    driversname: ["drivername", "driver_name", "driver.name"],
    tripdate: ["pickupdate", "pickup_date", "pickuptime", "pickup_time", "createddate", "created_date"],
    pickupaddress: ["pickupaddress", "pickup_address", "address.formatted", "addressformatted"],
    pickupstreetaddresscitystatezip: ["pickupaddress", "pickup_address", "address.formatted", "addressformatted"],
    dropoffaddress: ["dropoffaddress", "dropoff_address", "destination.formatted", "destinationformatted"],
    dropoffdestinationstreetaddresscitystatezip: ["dropoffaddress", "dropoff_address", "destination.formatted", "destinationformatted"],
    vehiclelicenseplateorvin: ["vehicleplate", "vin"],
    memberhealthfirstcoloradoid: ["accountreference", "account_reference"],
    escortname: [],
    fareamount: ["fareamount", "fare_amount"],
    distance: ["distance", "distancemiles", "distance_miles"],
    bookingid: ["bookingid", "booking_id", "tripid", "trip_id"],
    accountname: ["accountname", "account_name", "account.name"],
    status: ["status"],
    // Signature field aliases — normalize "Member's Signature" → memberssignature
    signature: ["paymentsignature", "payment.signature", "signatureurl", "signature_url"],
    memberssignature: ["paymentsignature", "payment.signature", "signatureurl", "signature_url"],
    membersignature: ["paymentsignature", "payment.signature", "signatureurl", "signature_url"],
    driversignature: ["paymentsignature", "payment.signature", "signatureurl", "signature_url"],
  };

  // Build normalized lookup for data columns
  const colIndex = dataColumns.map((c) => ({
    key: c.key,
    norm: normalize(c.key),
    labelNorm: normalize(c.label),
    parts: c.key.toLowerCase().split(/[_.\s-]+/),
  }));

  const usedColumns = new Set<string>();

  for (const ff of formFields) {
    const normName = normalize(ff.name);

    // 1. Exact normalized match on key or label
    let match = colIndex.find((c) => !usedColumns.has(c.key) && (c.norm === normName || c.labelNorm === normName));

    // 2. Alias lookup: check if this PDF field name matches a known alias
    if (!match) {
      const aliasCandidates = aliases[normName];
      if (aliasCandidates) {
        for (const alias of aliasCandidates) {
          const normAlias = normalize(alias);
          match = colIndex.find((c) => !usedColumns.has(c.key) && (c.norm === normAlias || c.key === alias));
          if (match) break;
        }
      }
    }

    // 3. Substring containment: form field contains column name or vice versa
    if (!match) {
      match = colIndex.find((c) =>
        !usedColumns.has(c.key) && (normName.includes(c.norm) || c.norm.includes(normName)) && c.norm.length > 2,
      );
    }

    // 4. Keyword overlap: split both and find >50% overlap
    if (!match) {
      const ffParts = ff.name.toLowerCase().replace(/'s\b/g, "").split(/[_.\s-]+/).filter((p) => p.length > 2);
      let bestScore = 0;
      for (const col of colIndex) {
        if (usedColumns.has(col.key)) continue;
        const overlap = ffParts.filter((p) => col.parts.some((cp) => cp.includes(p) || p.includes(cp))).length;
        const score = overlap / Math.max(ffParts.length, 1);
        if (score > 0.5 && score > bestScore) {
          bestScore = score;
          match = col;
        }
      }
    }

    if (match) {
      mappings[ff.name] = match.key;
      usedColumns.add(match.key);
    }
  }

  return mappings;
}

// ── Main component ──────────────────────────────────────────────

export default function TemplateDesigner({
  templateId,
  availableFields,
  sampleRow: sampleRowProp = {},
  onSave,
  onClose,
}: TemplateDesignerProps) {
  const designerContainerRef = useRef<HTMLDivElement>(null);
  const designerRef = useRef<any>(null);
  const isSampledataUpdateRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sampleRow = sampleRowProp;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [basePdfUploaded, setBasePdfUploaded] = useState(false);
  const [fieldMappings, setFieldMappings] = useState<Record<string, string>>({});
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [schemaFields, setSchemaFields] = useState<string[]>([]);
  const [draggedField, setDraggedField] = useState<{ key: string; label: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Form-fill mode state
  const [mode, setMode] = useState<"overlay" | "form_fill" | null>(null);
  const [formFields, setFormFields] = useState<PdfFormField[]>([]);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [fieldSearch, setFieldSearch] = useState("");


  // resolvedSampleRow: URL image values fetched → base64 data URIs
  const [resolvedSampleRow, setResolvedSampleRow] = useState<Record<string, unknown>>(sampleRow);

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
              const bytes = new Uint8Array(buf);
              let binary = "";
              for (let j = 0; j < bytes.length; j++) {
                binary += String.fromCharCode(bytes[j]);
              }
              const b64 = btoa(binary);
              if (!cancelled) resolved[key] = `data:${mime};base64,${b64}`;
            } catch {
              // leave as-is
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

        // Detect mode from stored schema
        const schema = tmpl.pdfme_schema;
        const isFormFill = schema?.mode === "form_fill";

        // AI auto-map: if form-fill mode with few/no existing mappings, fuzzy-match field names.
        // Strip legacy __sig_* metadata keys (old drag-overlay system, no longer used).
        // Keep ALL field_mappings including __sig_* position keys (placement coordinates)
        let initialMappings: Record<string, string> = { ...(tmpl.field_mappings ?? {}) };

        if (isFormFill && schema.form_fields) {
          const allFields = schema.form_fields as PdfFormField[];
          // Coverage: exclude __sig_* position keys and radio fields from the count
          const realMappingCount = Object.keys(initialMappings).filter((k) => !k.startsWith("__sig_")).length;
          const mappableFields = allFields; // Include radio fields in coverage count — they're now mappable
          const coverage = mappableFields.length > 0 ? realMappingCount / mappableFields.length : 1;

          if (coverage < 0.3) {
            // Preserve existing __sig_* position keys when re-mapping
            const posKeys = Object.fromEntries(
              Object.entries(initialMappings).filter(([k]) => k.startsWith("__sig_")),
            );
            initialMappings = { ...autoMapFields(allFields, availableFields), ...posKeys };
            // Persist
            if (Object.keys(initialMappings).length > 0) {
              fetchWithTenant(`/api/workspace/templates/${templateId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ field_mappings: initialMappings }),
              }).catch(() => {});
            }
          }
        }

        flushSync(() => {
          setBasePdfUploaded(!!tmpl.base_pdf_key);
          setFieldMappings(initialMappings);
          setMode(isFormFill ? "form_fill" : "overlay");
          if (isFormFill && schema.form_fields) {
            setFormFields(schema.form_fields);
          }
          if (schema && !isFormFill) {
            setSchemaFields(extractFieldNames(schema));
          }
          setLoading(false);
        });

        // Form fill mode: show annotated PDF in iframe (field names visible)
        if (isFormFill && tmpl.base_pdf_key) {
          const pdfRes = await fetchWithTenant(`/api/workspace/templates/${templateId}/annotated-pdf`);
          if (pdfRes.ok) {
            const blob = await pdfRes.blob();
            setPdfPreviewUrl(URL.createObjectURL(blob));
          }
        }

        // Overlay mode: init pdfme designer
        if (!isFormFill && tmpl.base_pdf_key) {
          await initDesigner(tmpl, tmpl.field_mappings ?? {});
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Load failed");
        setLoading(false);
      }
    }
    loadTemplate();
    return () => {
      // Cleanup designer on unmount
      if (designerRef.current) {
        designerRef.current.destroy();
        designerRef.current = null;
      }
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => { if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl); };
  }, [pdfPreviewUrl]);

  // pdf.js rendering into canvases — renders PDF as images we can overlay on
  // ── pdf.js canvas — renders the PDF as images so we can capture clicks ──
  const pdfWrapperRef = useRef<HTMLDivElement>(null);
  const pdfCanvasContainerRef = useRef<HTMLDivElement>(null);
  const [overlayScale, setOverlayScale] = useState(1);
  const [pdfPageInfo, setPdfPageInfo] = useState<Array<{ width: number; height: number }>>([]);
  const [pdfCanvasReady, setPdfCanvasReady] = useState(false);
  const [pdfCanvasError, setPdfCanvasError] = useState(false);

  // Which signature field is waiting for a click-to-place on the PDF
  const [placingSignature, setPlacingSignature] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "form_fill" || !pdfPreviewUrl) return;
    let cancelled = false;
    setPdfCanvasReady(false);
    setPdfCanvasError(false);
    setPlacingSignature(null);

    async function renderPdfToCanvas() {
      const CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136";
      if (!(window as any).__pdfjsLib) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.type = "module";
          s.textContent = `import * as pdfjsLib from "${CDN}/pdf.min.mjs"; window.__pdfjsLib = pdfjsLib;`;
          s.onerror = reject;
          document.head.appendChild(s);
          const check = setInterval(() => {
            if ((window as any).__pdfjsLib) { clearInterval(check); resolve(); }
          }, 50);
          setTimeout(() => { clearInterval(check); reject(new Error("pdf.js load timeout")); }, 10000);
        });
      }
      const pdfjsLib = (window as any).__pdfjsLib;
      pdfjsLib.GlobalWorkerOptions.workerSrc = `${CDN}/pdf.worker.min.mjs`;

      const resp = await fetch(pdfPreviewUrl!);
      const buf = await resp.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      const container = pdfCanvasContainerRef.current;
      if (!container || cancelled) return;

      const wrapperW = pdfWrapperRef.current?.clientWidth ?? 800;
      while (container.firstChild) container.removeChild(container.firstChild);
      const dims: Array<{ width: number; height: number }> = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp0 = page.getViewport({ scale: 1 });
        const scale = wrapperW / vp0.width;
        const vp = page.getViewport({ scale });
        if (i === 1 && !cancelled) setOverlayScale(scale);
        dims.push({ width: vp0.width, height: vp0.height });

        const canvas = document.createElement("canvas");
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        canvas.style.display = "block";
        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);
        container.appendChild(canvas);
        if (cancelled) return;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      }
      if (!cancelled) { setPdfPageInfo(dims); setPdfCanvasReady(true); }
    }

    renderPdfToCanvas().catch((err) => {
      console.error("PDF canvas render failed:", err);
      if (!cancelled) setPdfCanvasError(true);
    });
    return () => { cancelled = true; };
  }, [pdfPreviewUrl, mode]);

  /** Convert a click on the canvas container to PDF points */
  function handlePdfCanvasClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!placingSignature || !pdfCanvasReady) return;
    const container = pdfCanvasContainerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const pixelX = e.clientX - rect.left;
    const pixelY = e.clientY - rect.top;

    // Determine which page was clicked
    let cumH = 0, pageIdx = 0, yInPage = pixelY;
    for (let i = 0; i < pdfPageInfo.length; i++) {
      const ph = pdfPageInfo[i].height * overlayScale;
      if (pixelY < cumH + ph) { pageIdx = i; yInPage = pixelY - cumH; break; }
      cumH += ph;
    }
    const page = pdfPageInfo[pageIdx] ?? pdfPageInfo[0];
    if (!page) return;

    // PDF coordinates: x left-to-right, y bottom-to-top
    const pdfX = Math.round(pixelX / overlayScale);
    const pdfY = Math.round(page.height - yInPage / overlayScale);

    // Use the signature field's own size (from AcroForm rect) as default
    const sigField = formFields.find((f) => f.name === placingSignature && f.type === "signature");
    const w = Math.round(sigField?.rect?.width ?? 200);
    const h = Math.round(sigField?.rect?.height ?? 50);

    setFieldMappings((prev) => ({
      ...prev,
      [`__sig_x__${placingSignature}`]: String(pdfX),
      [`__sig_y__${placingSignature}`]: String(pdfY),
      [`__sig_w__${placingSignature}`]: String(w),
      [`__sig_h__${placingSignature}`]: String(h),
    }));
    setPlacingSignature(null);
  }

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

  // ── pdfme overlay mode functions ──

  async function initDesigner(tmpl: any, initialMappings?: Record<string, string>) {
    if (!designerContainerRef.current) return;
    try {
      const { Designer } = await import("@pdfme/ui");
      const { text, image } = await import("@pdfme/schemas");

      const pdfRes = await fetchWithTenant(`/api/workspace/templates/${templateId}/base-pdf`);
      if (!pdfRes.ok) throw new Error("Failed to load base PDF");
      const pdfBlob = await pdfRes.blob();
      const pdfArrayBuffer = await pdfBlob.arrayBuffer();
      const basePdf = new Uint8Array(pdfArrayBuffer);

      const schemas = tmpl.pdfme_schema ?? [[{ name: "field_1", type: "text", position: { x: 20, y: 20 }, width: 100, height: 10, fontSize: 12 }]];
      const activeMappings = initialMappings ?? fieldMappings;
      const enrichedSchemas = injectSampleValues(schemas, activeMappings, resolvedSampleRow);

      const template = {
        basePdf,
        schemas: enrichedSchemas,
        sampledata: buildSampledata(enrichedSchemas, activeMappings, resolvedSampleRow),
      } as any;

      if (designerRef.current) designerRef.current.destroy();

      designerRef.current = new Designer({
        domContainer: designerContainerRef.current,
        template,
        plugins: { text, image },
      });

      designerRef.current.onChangeTemplate((t: any) => {
        const fields = extractFieldNames(t.schemas);
        setSchemaFields(fields);
        if (isSampledataUpdateRef.current) return;
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

  // Live preview for overlay mode
  useEffect(() => {
    if (mode !== "overlay" || !designerRef.current) return;
    isSampledataUpdateRef.current = true;
    const tmpl = designerRef.current.getTemplate();
    const updatedSchemas = injectSampleValues(tmpl.schemas, fieldMappings, resolvedSampleRow);
    designerRef.current.updateTemplate({
      ...tmpl,
      schemas: updatedSchemas,
      sampledata: buildSampledata(updatedSchemas, fieldMappings, resolvedSampleRow),
    });
    setTimeout(() => { isSampledataUpdateRef.current = false; }, 50);
  }, [fieldMappings, resolvedSampleRow, mode]);

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

      const result = await res.json();

      if (result.mode === "form_fill") {
        // AI auto-map on fresh upload
        const autoMapped = autoMapFields(result.form_fields ?? [], availableFields);
        if (Object.keys(autoMapped).length > 0) {
          fetchWithTenant(`/api/workspace/templates/${templateId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field_mappings: autoMapped }),
          }).catch(() => {});
        }

        // Form-fill mode: show field mapping UI with real PDF preview
        flushSync(() => {
          setMode("form_fill");
          setFormFields(result.form_fields ?? []);
          setFieldMappings(autoMapped);
          setBasePdfUploaded(true);
          setLoading(false);
        });
        // Load annotated PDF for preview (shows field names)
        const pdfRes = await fetchWithTenant(`/api/workspace/templates/${templateId}/annotated-pdf`);
        if (pdfRes.ok) {
          const blob = await pdfRes.blob();
          if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
          setPdfPreviewUrl(URL.createObjectURL(blob));
        }
      } else {
        // Overlay mode: init pdfme designer
        const tmplRes = await fetchWithTenant(`/api/workspace/templates/${templateId}`);
        const tmpl = await tmplRes.json();
        flushSync(() => {
          setMode("overlay");
          setBasePdfUploaded(true);
          setLoading(false);
        });
        await initDesigner(tmpl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setLoading(false);
    }
  }

  // Save field mappings
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const body: any = { field_mappings: fieldMappings };

      if (mode === "overlay" && designerRef.current) {
        body.pdfme_schema = designerRef.current.getTemplate().schemas;
      }
      // form_fill mode: pdfme_schema already has { mode, form_fields } — just update field_mappings

      await fetchWithTenant(`/api/workspace/templates/${templateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [templateId, fieldMappings, mode, onSave]);

  // ── Refresh annotated PDF when mappings change (form-fill mode) ──
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevMappingsRef = useRef<Record<string, string>>(fieldMappings);
  useEffect(() => {
    if (mode !== "form_fill" || !basePdfUploaded) return;

    const prev = prevMappingsRef.current;
    const onlySigChanged = false; // legacy drag-overlay optimization removed
    prevMappingsRef.current = fieldMappings;

    // Debounce: save mappings to server, then optionally re-fetch annotated PDF
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(async () => {
      try {
        // Always persist mappings (including sig position/size)
        await fetchWithTenant(`/api/workspace/templates/${templateId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ field_mappings: fieldMappings }),
        });
        // Only re-fetch annotated PDF if non-signature mappings changed
        if (!onlySigChanged) {
          const pdfRes = await fetchWithTenant(`/api/workspace/templates/${templateId}/annotated-pdf`);
          if (pdfRes.ok) {
            const blob = await pdfRes.blob();
            if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
            setPdfPreviewUrl(URL.createObjectURL(blob));
          }
        }
      } catch { /* ignore refresh errors */ }
    }, 600);
    return () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); };
  }, [fieldMappings, mode, basePdfUploaded, templateId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Overlay mode: column drop handler ──
  function handleColumnDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (!draggedField || !designerRef.current) return;

    const container = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - container.left) / container.width;
    const relY = (e.clientY - container.top) / container.height;
    const pdfX = Math.max(5, Math.min(175, relX * 210 - 5));
    const pdfY = Math.max(5, Math.min(280, relY * 297));

    const existingNames = new Set(schemaFields);
    let fieldName = draggedField.key.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
    if (!fieldName) fieldName = "field";
    let candidate = fieldName;
    let n = 2;
    while (existingNames.has(candidate)) { candidate = `${fieldName}_${n++}`; }
    fieldName = candidate;

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

  // ── Render ──

  const filteredFormFields = fieldSearch
    ? formFields.filter((f) => f.name.toLowerCase().includes(fieldSearch.toLowerCase()))
    : formFields;

  const mappedCount = formFields.filter((f) => fieldMappings[f.name]).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
      <div className="bg-white rounded-xl shadow-2xl w-[95vw] h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-gray-800">Template Designer</h2>
            {mode === "form_fill" && (
              <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold uppercase rounded">
                Form Fill Mode
              </span>
            )}
            {mode === "overlay" && (
              <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-[10px] font-bold uppercase rounded">
                Overlay Mode
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
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
          {/* Left: PDF canvas / preview */}
          <div className="flex-1 flex flex-col relative">
            {!basePdfUploaded ? (
              /* Upload prompt */
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center space-y-4">
                  <div className="w-20 h-20 mx-auto bg-gray-100 rounded-2xl flex items-center justify-center">
                    <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-lg font-medium text-gray-700">Upload your PDF template</p>
                    <p className="text-sm text-gray-400 mt-1">
                      Fillable PDFs: form fields are detected automatically — just map data columns.<br/>
                      Flat PDFs: drag-and-drop text fields onto the document.
                    </p>
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
            ) : mode === "form_fill" ? (
              /* Form fill mode: pdf.js canvas so we can capture clicks for placement */
              <div ref={pdfWrapperRef} className="flex-1 w-full overflow-auto bg-gray-100 relative" style={{ minHeight: 0 }}>
                {pdfPreviewUrl ? (
                  <>
                    {/* Placement mode banner */}
                    {placingSignature && (
                      <div className="sticky top-0 z-30 flex items-center justify-between px-4 py-2.5 bg-pink-600 text-white text-sm font-medium shadow-md">
                        <span>🎯 Click anywhere on the PDF to place <strong>{placingSignature}</strong></span>
                        <button onClick={() => setPlacingSignature(null)} className="text-pink-200 hover:text-white text-xs underline">Cancel</button>
                      </div>
                    )}

                    {/* Canvas container — clickable when in placement mode */}
                    <div
                      className="relative"
                      style={{ cursor: placingSignature ? "crosshair" : "default" }}
                      onClick={handlePdfCanvasClick}
                    >
                      {pdfCanvasError ? (
                        <iframe src={pdfPreviewUrl} className="w-full border-0" style={{ height: "calc(90vh - 120px)" }} title="PDF Preview" />
                      ) : (
                        <div ref={pdfCanvasContainerRef} />
                      )}

                      {!pdfCanvasReady && !pdfCanvasError && (
                        <div className="flex items-center justify-center py-20">
                          <div className="animate-spin h-8 w-8 border-3 border-green-500 border-t-transparent rounded-full" />
                        </div>
                      )}

                      {/* Placed signature indicators — pink boxes showing where each signature will land */}
                      {pdfCanvasReady && !pdfCanvasError && pdfPageInfo.length > 0 &&
                        formFields.filter((ff) => ff.type === "signature" && fieldMappings[ff.name]).map((ff) => {
                          const px = fieldMappings[`__sig_x__${ff.name}`];
                          const py = fieldMappings[`__sig_y__${ff.name}`];
                          const pw = fieldMappings[`__sig_w__${ff.name}`];
                          const ph = fieldMappings[`__sig_h__${ff.name}`];
                          // Only show indicator if position was manually placed
                          if (!px || !py) return null;
                          const x = parseFloat(px);
                          const y = parseFloat(py);
                          const w = parseFloat(pw ?? "200");
                          const h = parseFloat(ph ?? "50");
                          // We don't track per-placement page yet — assume page 0
                          const page = pdfPageInfo[0];
                          if (!page) return null;
                          const screenX = x * overlayScale;
                          const screenY = (page.height - y - h) * overlayScale;
                          const screenW = w * overlayScale;
                          const screenH = h * overlayScale;
                          return (
                            <div
                              key={ff.name}
                              style={{ position: "absolute", left: screenX, top: screenY, width: screenW, height: screenH, pointerEvents: "none" }}
                              className="border-2 border-pink-500 bg-pink-200/30 rounded"
                            >
                              <span className="absolute -top-4 left-0 text-[9px] text-pink-600 font-bold bg-white px-1 rounded whitespace-nowrap">{ff.name}</span>
                            </div>
                          );
                        })
                      }
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-center py-20 text-gray-400">Loading PDF preview...</div>
                )}
              </div>
            ) : (
              /* Overlay mode: pdfme designer canvas */
              <div
                className="flex-1 w-full relative"
                style={{ minHeight: 0 }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleColumnDrop}
              >
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

          {/* Right panel */}
          {basePdfUploaded && !loading && mode === "form_fill" && (
            /* ── Form Fill Mode: field mapping panel ── */
            <div className="w-80 border-l border-gray-200 bg-gray-50 flex flex-col overflow-hidden relative z-10">
              {/* Header with stats */}
              <div className="p-4 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-gray-800">PDF Form Fields</h3>
                  <button
                    onClick={() => {
                      // Preserve __sig_* position keys when re-mapping
                      const posKeys = Object.fromEntries(Object.entries(fieldMappings).filter(([k]) => k.startsWith("__sig_")));
                      const newMappings = { ...autoMapFields(formFields, availableFields), ...posKeys };
                      setFieldMappings(newMappings);
                      fetchWithTenant(`/api/workspace/templates/${templateId}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ field_mappings: newMappings }),
                      }).catch(() => {});
                    }}
                    className="text-[9px] font-bold text-blue-600 hover:text-blue-800 px-1.5 py-0.5 rounded hover:bg-blue-50"
                  >
                    Auto-map
                  </button>
                </div>
                <p className="text-[11px] text-gray-500 mt-1">
                  {formFields.length} fields detected — map each to a data column
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <div className="flex-1 bg-gray-200 rounded-full h-1.5">
                    <div
                      className="bg-green-500 h-1.5 rounded-full transition-all"
                      style={{ width: `${formFields.length > 0 ? (mappedCount / formFields.length) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-500 font-medium">{mappedCount}/{formFields.length}</span>
                </div>
              </div>

              {/* Search */}
              <div className="px-4 py-2 border-b border-gray-200">
                <input
                  type="text"
                  value={fieldSearch}
                  onChange={(e) => setFieldSearch(e.target.value)}
                  placeholder="Search fields..."
                  className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>

              {/* Field list */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {filteredFormFields.map((ff) => {
                  const mapped = fieldMappings[ff.name];
                  const isStaticValue = mapped?.startsWith("__static:");
                  const staticVal = isStaticValue ? mapped.replace("__static:", "") : "";
                  const isMappedToColumn = mapped && !isStaticValue;
                  const preview = isMappedToColumn ? sampleRow[mapped] : null;

                  return (
                    <div
                      key={ff.name}
                      className={`rounded-lg border p-2.5 transition-colors ${
                        mapped ? "bg-green-50 border-green-200" : "bg-white border-gray-200"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5">
                          {mapped && (
                            <svg className="w-3.5 h-3.5 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/>
                            </svg>
                          )}
                          <span className="text-xs font-medium text-gray-800 truncate" title={ff.name}>{ff.name}</span>
                        </div>
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                          ff.type === "text" ? "bg-blue-100 text-blue-600" :
                          ff.type === "checkbox" ? "bg-amber-100 text-amber-600" :
                          ff.type === "radio" ? "bg-orange-100 text-orange-600" :
                          ff.type === "dropdown" ? "bg-purple-100 text-purple-600" :
                          ff.type === "signature" ? "bg-pink-100 text-pink-600" : /* maps to image URL/base64 */
                          "bg-gray-100 text-gray-500"
                        }`}>
                          {ff.type === "signature" ? "image" : ff.type}
                        </span>
                      </div>

                      {/* Type-specific controls */}
                      {ff.type === "signature" ? (
                        /* Signature: tap a column pill to map it. Position comes from the PDF field's own location. */
                        <div className="space-y-2">
                          <p className="text-[9px] text-pink-500 font-medium">Tap a column to place the signature image at this field's location:</p>
                          <div className="flex flex-wrap gap-1.5">
                            {availableFields
                              .filter((af) => {
                                // For signature fields, only show columns that look like image/signature URLs
                                const looksLikeImage = /sig|sign|image|photo|img|url/i.test(af.key + af.label);
                                const isCurrentlyMapped = mapped === af.key;
                                return looksLikeImage || isCurrentlyMapped;
                              })
                              .map((af) => {
                              const isSelected = mapped === af.key;
                              const looksLikeImage = true; // all remaining pills are image-like (pre-filtered above)
                              return (
                                <button
                                  key={af.key}
                                  onClick={() => setFieldMappings((prev) => {
                                    const next = { ...prev };
                                    for (const k of [`__sig_x__${ff.name}`, `__sig_y__${ff.name}`, `__sig_w__${ff.name}`, `__sig_h__${ff.name}`]) delete next[k];
                                    if (isSelected) { delete next[ff.name]; return next; }
                                    return { ...next, [ff.name]: af.key };
                                  })}
                                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
                                    isSelected
                                      ? "bg-pink-500 border-pink-500 text-white shadow-sm"
                                      : looksLikeImage
                                      ? "bg-pink-50 border-pink-300 text-pink-700 hover:bg-pink-100"
                                      : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50 hover:border-gray-400"
                                  }`}
                                >
                                  {isSelected && <span className="mr-1">✓</span>}{af.label}
                                </button>
                              );
                            })}
                          </div>
                          {isMappedToColumn && (
                            <>
                              <p className="text-[9px] text-pink-600 font-medium">✓ Mapped to: <span className="font-mono">{mapped}</span></p>
                              {/* Place on PDF button */}
                              <button
                                onClick={() => setPlacingSignature((p) => p === ff.name ? null : ff.name)}
                                className={`w-full mt-1 py-2 rounded-lg text-xs font-semibold border-2 transition-all ${
                                  placingSignature === ff.name
                                    ? "bg-pink-600 border-pink-600 text-white animate-pulse"
                                    : fieldMappings[`__sig_x__${ff.name}`]
                                    ? "bg-green-50 border-green-400 text-green-700 hover:bg-green-100"
                                    : "bg-pink-50 border-pink-400 text-pink-700 hover:bg-pink-100"
                                }`}
                              >
                                {placingSignature === ff.name
                                  ? "🎯 Click on the PDF now…"
                                  : fieldMappings[`__sig_x__${ff.name}`]
                                  ? "✅ Placed — click to reposition"
                                  : "📍 Click to place on PDF"}
                              </button>
                            </>
                          )}
                        </div>
                      ) : ff.type === "checkbox" ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                setFieldMappings((prev) => {
                                  const current = prev[ff.name];
                                  if (current === "__static:true") {
                                    const n = { ...prev };
                                    delete n[ff.name];
                                    return n;
                                  }
                                  return { ...prev, [ff.name]: "__static:true" };
                                });
                              }}
                              className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                                mapped === "__static:true"
                                  ? "bg-amber-500 border-amber-500 text-white"
                                  : "border-gray-300 hover:border-amber-400"
                              }`}
                            >
                              {mapped === "__static:true" && (
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7"/>
                                </svg>
                              )}
                            </button>
                            <span className="text-[10px] text-gray-500">
                              {mapped === "__static:true" ? "Always checked" : "Click to check"}
                            </span>
                          </div>
                          <div className="text-[9px] text-gray-400 uppercase tracking-wide">or map to column:</div>
                          <select
                            value={isMappedToColumn ? mapped : ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              setFieldMappings((prev) => {
                                if (!val) {
                                  const n = { ...prev };
                                  delete n[ff.name];
                                  return n;
                                }
                                return { ...prev, [ff.name]: val };
                              });
                            }}
                            className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-green-400"
                          >
                            <option value="">— Select data column —</option>
                            {availableFields.map((af) => (
                              <option key={af.key} value={af.key}>{af.label}</option>
                            ))}
                          </select>
                        </div>
                      ) : ff.type === "radio" ? (
                        /* Radio: clickable option buttons + column mapping fallback */
                        <div className="space-y-1.5">
                          {ff.options && ff.options.length > 0 ? (
                            <>
                              <div className="flex flex-wrap gap-1.5">
                                {ff.options.map((opt) => {
                                  const isSelected = staticVal === opt || mapped === `__static:${opt}`;
                                  return (
                                    <button
                                      key={opt}
                                      onClick={() => {
                                        setFieldMappings((prev) => {
                                          if (isSelected) {
                                            const n = { ...prev };
                                            delete n[ff.name];
                                            return n;
                                          }
                                          return { ...prev, [ff.name]: `__static:${opt}` };
                                        });
                                      }}
                                      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
                                        isSelected
                                          ? "bg-orange-500 border-orange-500 text-white shadow-sm"
                                          : "bg-white border-gray-300 text-gray-600 hover:bg-orange-50 hover:border-orange-300"
                                      }`}
                                    >
                                      {isSelected && <span className="mr-1">●</span>}{opt}
                                    </button>
                                  );
                                })}
                              </div>
                              <div className="text-[9px] text-gray-400 uppercase tracking-wide">or map to column:</div>
                            </>
                          ) : (
                            <input
                              type="text"
                              value={staticVal}
                              onChange={(e) => {
                                const val = e.target.value;
                                setFieldMappings((prev) => {
                                  if (!val) {
                                    const n = { ...prev };
                                    delete n[ff.name];
                                    return n;
                                  }
                                  return { ...prev, [ff.name]: `__static:${val}` };
                                });
                              }}
                              placeholder="Type value to select..."
                              className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-orange-400"
                            />
                          )}
                          <select
                            value={isMappedToColumn ? mapped : ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              setFieldMappings((prev) => {
                                if (!val) {
                                  const n = { ...prev };
                                  delete n[ff.name];
                                  return n;
                                }
                                return { ...prev, [ff.name]: val };
                              });
                            }}
                            className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-green-400"
                          >
                            <option value="">— Select data column —</option>
                            {availableFields.map((af) => (
                              <option key={af.key} value={af.key}>{af.label}</option>
                            ))}
                          </select>
                          {/* Derive from column with formula (e.g. AM/PM from time) */}
                          <div className="text-[9px] text-gray-400 uppercase tracking-wide">or derive AM/PM from:</div>
                          <select
                            value={mapped?.startsWith("__formula:") ? mapped.split(":")[1] : ""}
                            onChange={(e) => {
                              const col = e.target.value;
                              setFieldMappings((prev) => {
                                if (!col) {
                                  if (prev[ff.name]?.startsWith("__formula:")) {
                                    const n = { ...prev };
                                    delete n[ff.name];
                                    return n;
                                  }
                                  return prev;
                                }
                                return { ...prev, [ff.name]: `__formula:${col}:ampm` };
                              });
                            }}
                            className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                          >
                            <option value="">— Select time column —</option>
                            {availableFields.map((af) => (
                              <option key={af.key} value={af.key}>{af.label}</option>
                            ))}
                          </select>
                          {mapped?.startsWith("__formula:") && (
                            <div className="text-[10px] text-blue-500 font-medium">
                              Will auto-select AM (00:00-11:59) or PM (12:00-23:59) from {mapped.split(":")[1]}
                            </div>
                          )}
                        </div>
                      ) : (
                        /* Text/dropdown/other: column dropdown + optional static value */
                        <div className="space-y-1.5">
                          <select
                            value={isMappedToColumn ? mapped : ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              setFieldMappings((prev) => {
                                if (!val) {
                                  const n = { ...prev };
                                  delete n[ff.name];
                                  return n;
                                }
                                return { ...prev, [ff.name]: val };
                              });
                            }}
                            className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-green-400"
                          >
                            <option value="">— Select data column —</option>
                            {availableFields.map((af) => (
                              <option key={af.key} value={af.key}>{af.label}</option>
                            ))}
                          </select>
                          {!isMappedToColumn && (
                            <input
                              type="text"
                              value={staticVal}
                              onChange={(e) => {
                                const val = e.target.value;
                                setFieldMappings((prev) => {
                                  if (!val) {
                                    const n = { ...prev };
                                    delete n[ff.name];
                                    return n;
                                  }
                                  return { ...prev, [ff.name]: `__static:${val}` };
                                });
                              }}
                              placeholder="Or type a fixed value..."
                              className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder-gray-400"
                            />
                          )}
                        </div>
                      )}

                      {/* Preview value from sample data */}
                      {isMappedToColumn && preview !== undefined && preview !== null && (
                        <div className="mt-1.5 text-[10px] text-gray-500 truncate" title={String(preview)}>
                          Preview: <span className="text-gray-700 font-medium">{String(preview).slice(0, 60)}</span>
                        </div>
                      )}
                      {isStaticValue && staticVal && (
                        <div className="mt-1.5 text-[10px] text-blue-500">
                          Fixed: <span className="font-medium">{staticVal}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
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

          {basePdfUploaded && !loading && mode === "overlay" && (
            /* ── Overlay Mode: drag-drop panel (existing) ── */
            <div className="w-72 border-l border-gray-200 bg-gray-50 flex flex-col overflow-hidden">
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
