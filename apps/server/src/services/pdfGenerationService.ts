/**
 * PDF Generation Service
 * Two modes:
 *   1. Form Fill — fillable PDFs with AcroForm fields → pdf-lib fills them directly (preserves original PDF)
 *   2. Overlay   — flat PDFs → pdfme overlays text/images on top (legacy)
 */

import { generate } from "@pdfme/generator";
import { text, image, barcodes } from "@pdfme/schemas";
import type { Template } from "@pdfme/common";
import { PDFDocument, PDFName, PDFArray } from "pdf-lib";
import { downloadWorkspaceFile, uploadWorkspaceFile } from "./storageService.js";
import pino from "pino";
import path from "path";

const logger = pino({ name: "pdf-generation" });

// pdfme plugin registry
const plugins = { text, image, ...barcodes };

/** Max image fetch size (5 MB) and timeout (10s) */
const IMAGE_FETCH_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Check if a URL targets a private/reserved IP range (SSRF protection).
 * Blocks: loopback, link-local, private RFC1918, metadata endpoints.
 */
function isPrivateUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.startsWith("127.") ||
      host === "[::1]" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === "169.254.169.254" ||
      host.startsWith("169.254.") ||
      host.endsWith(".internal") ||
      host === "metadata.google.internal"
    ) {
      return true;
    }
    return false;
  } catch {
    return true; // malformed URL → block
  }
}

/**
 * Resolve a raw value to a pdfme-compatible image content string.
 * pdfme image fields require a base64 data URI (data:image/...;base64,...).
 * - Already a data URI → pass through
 * - URL (http/https) → fetch and convert to data URI (with SSRF + size + timeout guards)
 * - Raw base64 string → prepend data:image/jpeg;base64,
 * - Otherwise → empty string
 */
async function resolveImageValue(val: unknown): Promise<string> {
  if (val === null || val === undefined) return "";
  const str = String(val).trim();
  if (!str) return "";
  if (str.startsWith("data:")) return str;
  if (/^https?:\/\//i.test(str)) {
    if (isPrivateUrl(str)) {
      logger.warn({ url: str }, "Blocked private/internal URL in PDF image field (SSRF protection)");
      return "";
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
      const res = await fetch(str, { signal: controller.signal });
      clearTimeout(timer);
      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > IMAGE_FETCH_MAX_BYTES) {
        logger.warn({ url: str, size: contentLength }, "Image too large for PDF field");
        return "";
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > IMAGE_FETCH_MAX_BYTES) {
        logger.warn({ url: str, size: buf.length }, "Image response exceeded size limit");
        return "";
      }
      const mime = res.headers.get("content-type") || "image/jpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch (err) {
      logger.warn({ url: str, err }, "Failed to fetch image URL for PDF field");
      return "";
    }
  }
  // Assume raw base64
  return `data:image/jpeg;base64,${str}`;
}

/** Build a flat lookup of fieldName → field type from pdfme schema */
function buildFieldTypeMap(schema: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const pages = Array.isArray(schema) ? schema : [];
  for (const page of pages) {
    const fields = Array.isArray(page) ? page : Object.values(page as object);
    for (const field of fields as any[]) {
      if (field?.name && field?.type) map[field.name] = field.type;
    }
  }
  return map;
}

export async function generatePdf(
  template: Template,
  data: Record<string, unknown>,
  fieldMappings: Record<string, string>,
): Promise<Buffer> {
  const fieldTypes = buildFieldTypeMap(template.schemas);

  // Build pdfme input by mapping template field names -> row data values
  const input: Record<string, string> = {};

  for (const [templateField, columnKey] of Object.entries(fieldMappings)) {
    // Support static values: "__static:someValue" bypasses data lookup
    if (columnKey.startsWith("__static:")) {
      input[templateField] = columnKey.replace("__static:", "");
      continue;
    }
    const rawValue = data[columnKey];
    if (rawValue === null || rawValue === undefined) {
      input[templateField] = "";
    } else if (fieldTypes[templateField] === "image") {
      // Image fields need a base64 data URI — fetch URLs, wrap raw base64
      input[templateField] = await resolveImageValue(rawValue);
    } else {
      input[templateField] = String(rawValue);
    }
  }

  const pdf = await generate({
    template,
    inputs: [input],
    plugins,
  });

  return Buffer.from(pdf);
}

/**
 * Load a template from the database record, fetching the base PDF from S3.
 */
export async function loadTemplate(
  basePdfKey: string,
  pdfmeSchema: unknown,
): Promise<Template> {
  let pdfBuffer: Buffer;

  if (basePdfKey.startsWith("local:")) {
    // Local disk storage (dev without Docker/MinIO)
    const { readFileSync } = await import("fs");
    const baseDir = path.resolve(process.cwd(), "uploads/templates");
    const localPath = path.resolve(baseDir, basePdfKey.replace("local:templates/", ""));
    if (!localPath.startsWith(baseDir + path.sep) && localPath !== baseDir) {
      throw new Error("Invalid template path — traversal detected");
    }
    pdfBuffer = readFileSync(localPath);
  } else {
    const result = await downloadWorkspaceFile(basePdfKey);
    pdfBuffer = result.body as Buffer;
  }

  const basePdfB64 = `data:application/pdf;base64,${pdfBuffer.toString("base64")}`;

  const schema = pdfmeSchema as Template["schemas"];

  return {
    basePdf: basePdfB64,
    schemas: schema,
  };
}

/**
 * Generate PDFs for a batch of rows and upload to S3.
 * Returns array of { filename, s3Key, rowIndex }.
 */
export async function generateBatchPdfs(
  basePdfKey: string,
  pdfmeSchema: unknown,
  fieldMappings: Record<string, string>,
  dataset: Record<string, unknown>[],
  companyId: string,
  runId: string,
  filenamePattern: string = "{trip_id}-{name}.pdf",
): Promise<Array<{ filename: string; s3Key: string; rowIndex: number }>> {
  const template = await loadTemplate(basePdfKey, pdfmeSchema);
  const results: Array<{ filename: string; s3Key: string; rowIndex: number }> = [];

  for (let i = 0; i < dataset.length; i++) {
    const row = dataset[i];

    try {
      const pdfBuffer = await generatePdf(template, row, fieldMappings);

      // Build filename from pattern
      let filename = filenamePattern;
      for (const [key, val] of Object.entries(row)) {
        const safeVal = String(val ?? "")
          .replace(/[^a-zA-Z0-9_\-. ]/g, "")
          .slice(0, 50);
        filename = filename.replace(`{${key}}`, safeVal);
      }
      // Clean up any remaining placeholders
      filename = filename.replace(/\{[^}]+\}/g, "unknown");
      if (!filename.endsWith(".pdf")) filename += ".pdf";
      // Strip any directory traversal from the final filename
      filename = path.basename(filename);

      // Save to local disk (fallback for dev without S3/MinIO)
      const { mkdirSync, writeFileSync } = await import("fs");
      const outDir = path.resolve(process.cwd(), "uploads/runs", companyId, runId);
      mkdirSync(outDir, { recursive: true });
      const outPath = path.resolve(outDir, filename);
      if (!outPath.startsWith(outDir + path.sep) && outPath !== outDir) {
        throw new Error("Invalid output filename — traversal detected");
      }
      writeFileSync(outPath, pdfBuffer);
      const s3Key = `local:runs/${companyId}/${runId}/${filename}`;

      results.push({ filename, s3Key, rowIndex: i });
      logger.info({ filename, rowIndex: i }, "Generated PDF");
    } catch (err) {
      logger.error({ rowIndex: i, error: err instanceof Error ? err.message : String(err) }, "Failed to generate PDF for row");
      results.push({ filename: `error-row-${i}.pdf`, s3Key: "", rowIndex: i });
    }
  }

  return results;
}

// ─── Form Fill Mode (pdf-lib) ────────────────────────────────────────────────

export interface PdfFormField {
  name: string;
  type: "text" | "checkbox" | "dropdown" | "radio" | "signature" | "unknown";
  /** For signature fields: raw PDF rect position + page dimensions */
  rect?: { x: number; y: number; width: number; height: number };
  pageIndex?: number;
  pageWidth?: number;
  pageHeight?: number;
}

/**
 * Extract AcroForm fields from a PDF buffer.
 * Returns an empty array for non-fillable PDFs.
 */
export async function extractFormFields(pdfBuffer: Buffer): Promise<PdfFormField[]> {
  try {
    const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const form = doc.getForm();
    const fields = form.getFields();
    const pages = doc.getPages();
    return fields.map((f) => {
      const name = f.getName();
      const constructor = f.constructor.name;
      let type: PdfFormField["type"] = "unknown";
      if (constructor === "PDFTextField") type = "text";
      else if (constructor === "PDFCheckBox") type = "checkbox";
      else if (constructor === "PDFDropdown") type = "dropdown";
      else if (constructor === "PDFRadioGroup") type = "radio";
      else if (constructor === "PDFSignature") type = "signature";

      if (type === "signature") {
        try {
          const widgets = f.acroField.getWidgets();
          if (widgets.length > 0) {
            const widget = widgets[0];
            const rectObj = widget.dict.get(PDFName.of("Rect"));
            let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
            if (rectObj instanceof PDFArray) {
              for (let ri = 0; ri < rectObj.size(); ri++) {
                const v = rectObj.get(ri);
                const n = typeof (v as any)?.asNumber === "function" ? (v as any).asNumber() : 0;
                if (ri === 0) x1 = n; else if (ri === 1) y1 = n; else if (ri === 2) x2 = n; else y2 = n;
              }
            }
            const left = Math.min(x1, x2);
            const bottom = Math.min(y1, y2);
            const width = Math.abs(x2 - x1);
            const height = Math.abs(y2 - y1);

            let pageIndex = 0;
            let pageWidth = pages[0]?.getWidth() ?? 0;
            let pageHeight = pages[0]?.getHeight() ?? 0;
            const pageRef = widget.P();
            if (pageRef) {
              const idx = pages.findIndex((p: any) => p.ref === pageRef);
              if (idx >= 0) {
                pageIndex = idx;
                pageWidth = pages[idx].getWidth();
                pageHeight = pages[idx].getHeight();
              }
            }
            return { name, type, rect: { x: left, y: bottom, width, height }, pageIndex, pageWidth, pageHeight };
          }
        } catch {
          // Fall through to basic return
        }
      }

      return { name, type };
    });
  } catch (err) {
    logger.debug({ err }, "No AcroForm fields found (non-fillable PDF)");
    return [];
  }
}

/**
 * Load the raw PDF buffer from local disk or S3 (with path traversal protection).
 */
export async function loadPdfBuffer(basePdfKey: string): Promise<Buffer> {
  if (basePdfKey.startsWith("local:")) {
    const { readFileSync } = await import("fs");
    const baseDir = path.resolve(process.cwd(), "uploads/templates");
    const localPath = path.resolve(baseDir, basePdfKey.replace("local:templates/", ""));
    if (!localPath.startsWith(baseDir + path.sep) && localPath !== baseDir) {
      throw new Error("Invalid template path — traversal detected");
    }
    return readFileSync(localPath);
  } else {
    const result = await downloadWorkspaceFile(basePdfKey);
    return result.body as Buffer;
  }
}

/**
 * Resolve a value to a raw image buffer + mime for pdf-lib embedding.
 * Supports: data URI, http(s) URL, raw base64.
 */
async function resolveImageBuffer(val: string): Promise<{ buf: Buffer; mime: string } | null> {
  const str = val.trim();
  if (!str) return null;

  if (str.startsWith("data:")) {
    const match = str.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return null;
    return { buf: Buffer.from(match[2], "base64"), mime: match[1] };
  }

  if (/^https?:\/\//i.test(str)) {
    if (isPrivateUrl(str)) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
      const res = await fetch(str, { signal: controller.signal });
      clearTimeout(timer);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > IMAGE_FETCH_MAX_BYTES) return null;
      const mime = res.headers.get("content-type") || "image/jpeg";
      return { buf, mime };
    } catch {
      return null;
    }
  }

  // Assume raw base64
  try {
    return { buf: Buffer.from(str, "base64"), mime: "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * Fill a single PDF form using pdf-lib. Preserves the original PDF exactly —
 * dimensions, fonts, checkboxes, everything. Only touches mapped fields.
 *
 * Signature fields: pdf-lib can't fill PDFSignature fields directly, so we
 * detect the field's rectangle, embed the image, and draw it on the page.
 */
export async function fillPdfForm(
  pdfBuffer: Buffer,
  data: Record<string, unknown>,
  fieldMappings: Record<string, string>,
): Promise<Buffer> {
  const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const form = doc.getForm();

  // Debug: log all PDF field names and the mappings we received
  const allFieldNames = form.getFields().map((f) => `${f.getName()} (${f.constructor.name})`);
  const mappingCount = Object.keys(fieldMappings).filter((k) => !k.startsWith("__sig_")).length;
  console.log(`[fillPdfForm] PDF has ${allFieldNames.length} fields: ${allFieldNames.join(", ")}`);
  console.log(`[fillPdfForm] Received ${mappingCount} field mappings: ${JSON.stringify(Object.fromEntries(Object.entries(fieldMappings).filter(([k]) => !k.startsWith("__sig_"))))}`);

  // Clear ALL text fields first so stale/placeholder values (e.g. "asdf") don't persist
  for (const field of form.getFields()) {
    const ctor = field.constructor.name;
    if (ctor === "PDFTextField") {
      try { form.getTextField(field.getName()).setText(""); } catch {}
    }
  }

  for (const [formFieldName, columnKey] of Object.entries(fieldMappings)) {
    // Support static values: "__static:someValue" bypasses data lookup
    let strValue: string;
    if (columnKey.startsWith("__static:")) {
      strValue = columnKey.replace("__static:", "");
    } else {
      const rawValue = data[columnKey];
      if (rawValue === null || rawValue === undefined) continue;
      strValue = String(rawValue);
    }

    try {
      const field = form.getField(formFieldName);
      const constructor = field.constructor.name;

      if (constructor === "PDFTextField") {
        form.getTextField(formFieldName).setText(strValue);
      } else if (constructor === "PDFCheckBox") {
        const truthy = ["true", "1", "yes", "on"].includes(strValue.toLowerCase());
        if (truthy) form.getCheckBox(formFieldName).check();
        else form.getCheckBox(formFieldName).uncheck();
      } else if (constructor === "PDFDropdown") {
        form.getDropdown(formFieldName).select(strValue);
      } else if (constructor === "PDFRadioGroup") {
        form.getRadioGroup(formFieldName).select(strValue);
      } else if (constructor === "PDFSignature") {
        // Signature fields can't be filled via AcroForm API.
        // Read raw /Rect [x1,y1,x2,y2] from PDF dict to get true page coordinates.
        const imageData = await resolveImageBuffer(strValue);
        if (!imageData) continue;

        const widgets = field.acroField.getWidgets();
        if (widgets.length === 0) continue;
        const widget = widgets[0];

        // Read raw rect from PDF dictionary (bypasses rotation issues)
        const { PDFName, PDFArray } = await import("pdf-lib");
        const rectObj = widget.dict.get(PDFName.of("Rect"));
        let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        if (rectObj instanceof PDFArray) {
          const nums = [];
          for (let ri = 0; ri < rectObj.size(); ri++) {
            const v = rectObj.get(ri);
            nums.push(typeof (v as any)?.asNumber === "function" ? (v as any).asNumber() : 0);
          }
          [x1, y1, x2, y2] = nums;
        }
        // Use the PDF form field's own position and size directly
        const left = Math.min(x1, x2);
        const bottom = Math.min(y1, y2);
        const posX = left;
        const posY = bottom;
        // Derive target size from the PDF rect (abs diff); fall back to sensible defaults
        const targetW = Math.abs(x2 - x1) || 200;
        const targetH = Math.abs(y2 - y1) || 50;

        const pageRef = widget.P();
        const pages = doc.getPages();
        let targetPage = pages[0];
        if (pageRef) {
          const idx = pages.findIndex((p) => p.ref === pageRef);
          if (idx >= 0) targetPage = pages[idx];
        }

        // Prefer PNG for transparency support
        let embeddedImage;
        if (imageData.mime.includes("png")) {
          embeddedImage = await doc.embedPng(imageData.buf);
        } else {
          embeddedImage = await doc.embedJpg(imageData.buf);
        }

        // Fit image within the target area, preserving aspect ratio
        const imgAspect = embeddedImage.width / embeddedImage.height;
        const targetAspect = targetW / targetH;
        let drawW: number, drawH: number;
        if (imgAspect > targetAspect) {
          drawW = targetW;
          drawH = targetW / imgAspect;
        } else {
          drawH = targetH;
          drawW = targetH * imgAspect;
        }

        // Center the image on the (possibly overridden) position
        const drawX = posX + (targetW - drawW) / 2;
        const drawY = posY + (targetH - drawH) / 2;

        targetPage.drawImage(embeddedImage, { x: drawX, y: drawY, width: drawW, height: drawH });

        // Remove the signature field so it doesn't overlay our image
        form.removeField(field);
        logger.info({ field: formFieldName, targetW, targetH }, "Embedded signature image on PDF");
      }
    } catch (err) {
      logger.warn({ field: formFieldName, err }, "Failed to fill form field");
    }
  }

  // Flatten form so fields render as static content in all viewers
  form.flatten();
  const filled = await doc.save();
  return Buffer.from(filled);
}

/**
 * Generate PDFs for a batch of rows using form-fill mode (pdf-lib).
 * Same interface as generateBatchPdfs but preserves the original PDF structure.
 */
export async function generateBatchFormFillPdfs(
  basePdfKey: string,
  fieldMappings: Record<string, string>,
  dataset: Record<string, unknown>[],
  companyId: string,
  runId: string,
  filenamePattern: string = "{trip_id}-{name}.pdf",
): Promise<Array<{ filename: string; s3Key: string; rowIndex: number }>> {
  const pdfBuffer = await loadPdfBuffer(basePdfKey);
  const results: Array<{ filename: string; s3Key: string; rowIndex: number }> = [];

  for (let i = 0; i < dataset.length; i++) {
    const row = dataset[i];

    try {
      const filledPdf = await fillPdfForm(pdfBuffer, row, fieldMappings);

      // Build filename from pattern
      let filename = filenamePattern;
      for (const [key, val] of Object.entries(row)) {
        const safeVal = String(val ?? "")
          .replace(/[^a-zA-Z0-9_\-. ]/g, "")
          .slice(0, 50);
        filename = filename.replace(`{${key}}`, safeVal);
      }
      filename = filename.replace(/\{[^}]+\}/g, "unknown");
      if (!filename.endsWith(".pdf")) filename += ".pdf";
      filename = path.basename(filename);

      const { mkdirSync, writeFileSync } = await import("fs");
      const outDir = path.resolve(process.cwd(), "uploads/runs", companyId, runId);
      mkdirSync(outDir, { recursive: true });
      const outPath = path.resolve(outDir, filename);
      if (!outPath.startsWith(outDir + path.sep) && outPath !== outDir) {
        throw new Error("Invalid output filename — traversal detected");
      }
      writeFileSync(outPath, filledPdf);
      const s3Key = `local:runs/${companyId}/${runId}/${filename}`;

      results.push({ filename, s3Key, rowIndex: i });
      logger.info({ filename, rowIndex: i }, "Generated form-filled PDF");
    } catch (err) {
      logger.error({ rowIndex: i, error: err instanceof Error ? err.message : String(err) }, "Failed to fill PDF form for row");
      results.push({ filename: `error-row-${i}.pdf`, s3Key: "", rowIndex: i });
    }
  }

  return results;
}
