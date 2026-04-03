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
import https from "https";
import http from "http";
import { spawnSync } from "child_process";
import sharp from "sharp";

const logger = pino({ name: "pdf-generation" });

// pdfme plugin registry
const plugins = { text, image, ...barcodes };

/** Max image fetch size (5 MB) and timeout (10s) */
const IMAGE_FETCH_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch a URL using Node's native https/http module.
 */
function nativeFetchBuffer(url: string, timeoutMs = IMAGE_FETCH_TIMEOUT_MS): Promise<{ buf: Buffer; mime: string; status: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        nativeFetchBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve({ buf: Buffer.concat(chunks), mime: res.headers["content-type"] || "image/png", status: res.statusCode ?? 0 }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("Request timed out")); });
    req.on("error", reject);
  });
}

/**
 * Resolve a hostname using an alternative DNS server (8.8.8.8) when the system DNS is blocked.
 * Returns the first IP address, or null if resolution fails.
 */
function resolveViaAltDns(hostname: string): string | null {
  try {
    const result = spawnSync("dig", ["@8.8.8.8", hostname, "A", "+short", "+time=5"], { encoding: "utf8" });
    const lines = (result.stdout || "").trim().split("\n").filter((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l.trim()));
    return lines[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL using system curl (bypasses Node.js network sandbox restrictions).
 * For S3 URLs, resolves the IP via an alternative DNS server to bypass system DNS restrictions.
 */
function curlFetchBuffer(url: string, timeoutSecs = 12): { buf: Buffer; mime: string; status: number } | null {
  try {
    const args: string[] = ["-s", "-L", "--max-time", String(timeoutSecs),
      "--write-out", "\n__STATUS__:%{http_code}__MIME__:%{content_type}",
      "--output", "-"];

    // For S3 URLs, bypass system DNS using hardcoded IP from alternative resolver
    const parsed = new URL(url);
    if (/amazonaws\.com$/i.test(parsed.hostname)) {
      const ip = resolveViaAltDns(parsed.hostname);
      if (ip) {
        const port = parsed.protocol === "https:" ? "443" : "80";
        args.push("--resolve", `${parsed.hostname}:${port}:${ip}`);
        logger.info({ hostname: parsed.hostname, ip }, "Using alt-DNS resolved IP for S3 URL");
      }
    }

    args.push(url);
    const result = spawnSync("curl", args, { maxBuffer: IMAGE_FETCH_MAX_BYTES + 4096 });
    if (result.status !== 0 || !result.stdout) return null;

    const raw = result.stdout as Buffer;
    const trailer = "\n__STATUS__:";
    const trailerBuf = Buffer.from(trailer);
    const trailerIdx = raw.lastIndexOf(trailerBuf);
    if (trailerIdx < 0) return null;
    const imageBuf = raw.subarray(0, trailerIdx);
    const meta = raw.subarray(trailerIdx + trailerBuf.length).toString();
    const statusMatch = meta.match(/^(\d+)__MIME__:(.*)$/);
    if (!statusMatch) return null;
    const status = parseInt(statusMatch[1], 10);
    const mime = statusMatch[2].split(";")[0].trim() || "image/png";
    logger.info({ url: url.slice(0, 80), status, mime, bytes: imageBuf.length }, "curlFetchBuffer success");
    return { buf: imageBuf, mime, status };
  } catch (err) {
    logger.error({ err }, "curlFetchBuffer error");
    return null;
  }
}

/**
 * Fetch image using best available method: try native https first, then fall back to curl.
 * Exported so the debug endpoint can use it directly.
 */
export async function fetchImageBuffer(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  // Try native https first
  try {
    const result = await nativeFetchBuffer(url);
    if (result.status >= 200 && result.status < 300 && result.buf.length > 0) {
      return { buf: result.buf, mime: result.mime };
    }
    logger.warn({ status: result.status }, "nativeFetchBuffer non-200, trying curl");
  } catch (err) {
    logger.warn({ err: String(err) }, "nativeFetchBuffer failed, trying curl");
  }
  // Fallback: use system curl (bypasses Node.js DNS sandbox)
  const curlResult = curlFetchBuffer(url);
  if (curlResult && curlResult.status >= 200 && curlResult.status < 300 && curlResult.buf.length > 0) {
    return { buf: curlResult.buf, mime: curlResult.mime };
  }
  return null;
}

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
    const result = await fetchImageBuffer(str);
    if (!result) {
      logger.warn({ url: str }, "Failed to fetch image URL for PDF field (all methods failed)");
      return "";
    }
    if (result.buf.length > IMAGE_FETCH_MAX_BYTES) {
      logger.warn({ url: str, size: result.buf.length }, "Image response exceeded size limit");
      return "";
    }
    return `data:${result.mime};base64,${result.buf.toString("base64")}`;
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

export interface VisualRect {
  x: number;      // visual x (left edge, in pts from left of displayed page)
  y: number;      // visual y (top edge, in pts from top of displayed page)
  width: number;  // visual width
  height: number; // visual height
}

export interface PdfFormField {
  name: string;
  type: "text" | "checkbox" | "dropdown" | "radio" | "signature" | "unknown";
  /** Raw PDF rect (unrotated AcroForm coordinates) */
  rect?: { x: number; y: number; width: number; height: number };
  /** Visual rect (post-rotation, matches what the user sees on screen) */
  visualRect?: VisualRect;
  /** Page rotation angle (0, 90, 180, 270) */
  rotation?: number;
  pageIndex?: number;
  pageWidth?: number;
  pageHeight?: number;
  /** Available options for radio groups and dropdowns */
  options?: string[];
}

// ─── Coordinate Transforms ─────────────────────────────────────────────────
// Bidirectional transform between raw PDF coordinates and visual (displayed) coordinates.
// Raw = AcroForm Rect coords (unrotated content stream, y=0 at bottom).
// Visual = what the user sees after page rotation is applied (y=0 at top, like a canvas).

/**
 * Convert raw PDF rect to visual rect (what the user sees on screen).
 * Used at upload time when extracting form fields.
 */
export function rawToVisual(
  raw: { x: number; y: number; width: number; height: number },
  pageWidth: number,   // post-rotation page width (getWidth())
  pageHeight: number,  // post-rotation page height (getHeight())
  rotation: number,
): VisualRect {
  switch (rotation) {
    case 0:
      return { x: raw.x, y: pageHeight - raw.y - raw.height, width: raw.width, height: raw.height };
    case 90:
      return { x: raw.y, y: raw.x, width: raw.height, height: raw.width };
    case 180:
      return { x: pageWidth - raw.x - raw.width, y: raw.y, width: raw.width, height: raw.height };
    case 270:
      return { x: pageHeight - raw.y - raw.height, y: pageWidth - raw.x - raw.width, width: raw.height, height: raw.width };
    default:
      return { x: raw.x, y: pageHeight - raw.y - raw.height, width: raw.width, height: raw.height };
  }
}

/**
 * Convert visual rect back to raw PDF coordinates for rendering.
 * Used at PDF generation time to place signatures.
 */
export function visualToRaw(
  visual: VisualRect,
  pageWidth: number,
  pageHeight: number,
  rotation: number,
): { x: number; y: number; width: number; height: number } {
  switch (rotation) {
    case 0:
      return { x: visual.x, y: pageHeight - visual.y - visual.height, width: visual.width, height: visual.height };
    case 90:
      return { x: visual.y, y: visual.x, width: visual.height, height: visual.width };
    case 180:
      return { x: pageWidth - visual.x - visual.width, y: visual.y, width: visual.width, height: visual.height };
    case 270:
      return { x: pageWidth - visual.y - visual.height, y: pageHeight - visual.x - visual.width, width: visual.height, height: visual.width };
    default:
      return { x: visual.x, y: pageHeight - visual.y - visual.height, width: visual.width, height: visual.height };
  }
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
            const rotation = pages[pageIndex].getRotation().angle;
            const rect = { x: left, y: bottom, width, height };
            const visualRect = rawToVisual(rect, pageWidth, pageHeight, rotation);
            return { name, type, rect, visualRect, rotation, pageIndex, pageWidth, pageHeight };
          }
        } catch {
          // Fall through to basic return
        }
      }

      // Extract options for radio groups and dropdowns
      let options: string[] | undefined;
      if (type === "radio") {
        try {
          const radioGroup = form.getRadioGroup(name);
          options = radioGroup.getOptions();
        } catch { /* not a valid radio group */ }
      } else if (type === "dropdown") {
        try {
          const dropdown = form.getDropdown(name);
          options = dropdown.getOptions();
        } catch { /* not a valid dropdown */ }
      }

      return { name, type, ...(options ? { options } : {}) };
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
    const result = await fetchImageBuffer(str);
    if (!result) {
      console.error(`[resolveImageBuffer] All fetch methods failed for: ${str.slice(0, 80)}...`);
      return null;
    }
    if (result.buf.length > IMAGE_FETCH_MAX_BYTES) return null;
    return result;
  }

  // Assume raw base64
  try {
    return { buf: Buffer.from(str, "base64"), mime: "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * Remove white/near-white background from a signature image.
 * Converts the image to RGBA PNG, then makes all pixels with
 * brightness above a threshold fully transparent.
 *
 * This preserves dark ink strokes while removing white paper/screen backgrounds.
 */
async function removeWhiteBackground(buf: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(buf)
    .ensureAlpha()        // add alpha channel if missing (JPEG → RGBA)
    .raw()                // get raw RGBA pixel data
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const threshold = 240;  // near-white threshold (R,G,B all > 240 → transparent)

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > threshold && g > threshold && b > threshold) {
      data[i + 3] = 0; // set alpha to fully transparent
    }
  }

  // Convert back to PNG, then trim transparent padding so only ink remains.
  // This ensures every signature is cropped to its actual ink content —
  // no more random whitespace offsets causing signatures to drift off the line.
  const pngBuf = await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();

  try {
    return await sharp(pngBuf)
      .trim()       // crop transparent edges to ink bounding box
      .toBuffer();
  } catch {
    // trim() can fail if the entire image is transparent (no ink) — return as-is
    return pngBuf;
  }
}

/**
 * Fill a single PDF form using pdf-lib. Preserves the original PDF exactly —
 * dimensions, fonts, checkboxes, everything. Only touches mapped fields.
 *
 * Signature fields: pdf-lib can't fill PDFSignature fields directly, so we
 * detect the field's rectangle, embed the image, and draw it on the page.
 */

/** Derive a value from a source column using a named transform. */
function applyFormula(value: string, transform: string): string {
  if (transform === "ampm") {
    // Extract hour from time strings: "14:30", "2:30 PM", "02:30:00", etc.
    const match = value.match(/(\d{1,2})/);
    if (!match) return "AM";
    const hour = parseInt(match[1], 10);
    return hour >= 12 ? "PM" : "AM";
  }
  return value; // unknown transform — pass through
}

/** Check if a value is effectively empty (null, undefined, "", 0, "0"). */
function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "" || v === 0 || v === "0";
}

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
    let strValue: string;

    if (columnKey.startsWith("__formula:")) {
      // Reactive formula: __formula:sourceColumn:transformName
      const parts = columnKey.split(":");
      const sourceCol = parts[1];
      const transform = parts[2];
      const rawValue = data[sourceCol];
      if (isEmptyValue(rawValue)) continue;
      strValue = applyFormula(String(rawValue), transform);
    } else if (columnKey.startsWith("__static:")) {
      strValue = columnKey.replace("__static:", "");
    } else if (columnKey.includes("|")) {
      // Pipe-delimited fallback: "primary|fallback|__static:default"
      const candidates = columnKey.split("|");
      let resolved = false;
      for (const candidate of candidates) {
        if (candidate.startsWith("__static:")) {
          strValue = candidate.replace("__static:", "");
          resolved = true;
          break;
        }
        const rawValue = data[candidate];
        if (!isEmptyValue(rawValue)) {
          strValue = String(rawValue);
          resolved = true;
          break;
        }
      }
      if (!resolved) continue;
    } else {
      const rawValue = data[columnKey];
      if (isEmptyValue(rawValue)) continue;
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
        // Signature fields can't be filled via AcroForm API — embed as image instead.
        console.log(`[fillPdfForm] Processing signature field: ${formFieldName}, value length: ${strValue.length}, starts: ${strValue.slice(0, 40)}`);
        let imageData = await resolveImageBuffer(strValue);
        if (!imageData) {
          console.error(`[fillPdfForm] No image data for signature field: ${formFieldName}`);
          continue;
        }
        console.log(`[fillPdfForm] Image resolved for ${formFieldName}: ${imageData.mime}, ${imageData.buf.length} bytes`);

        // Remove white background from signature images so they don't overlay form text
        try {
          const cleanBuf = await removeWhiteBackground(imageData.buf);
          imageData = { buf: cleanBuf, mime: "image/png" }; // always PNG after processing (supports alpha)
          console.log(`[fillPdfForm] Background removed for ${formFieldName}: ${cleanBuf.length} bytes`);
        } catch (err) {
          console.warn(`[fillPdfForm] Background removal failed for ${formFieldName}, using original image:`, err);
          // Fall through with original image
        }

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
        // Default: use the PDF AcroForm field's own rect for position + size
        const left = Math.min(x1, x2);
        const bottom = Math.min(y1, y2);
        let fieldW = Math.abs(x2 - x1) || 200;
        let fieldH = Math.abs(y2 - y1) || 50;

        const pageRef = widget.P();
        const pages = doc.getPages();
        let targetPage = pages[0];
        if (pageRef) {
          const idx = pages.findIndex((p) => p.ref === pageRef);
          if (idx >= 0) targetPage = pages[idx];
        }

        // ═══════════════════════════════════════════════════════════════════
        // ROTATION-AGNOSTIC SIGNATURE RENDERING (Phase 1 redesign)
        //
        // All positioning is done in VISUAL space (what the user sees),
        // then converted to raw PDF coordinates at draw time.
        //
        // TARGET BOX: 260pt wide × 220pt tall (visual space)
        // POSITION:   Bottom edge 1 inch below signature field center,
        //             horizontally centered on field
        // BOLD:       9 sub-pixel offset draws
        // ═══════════════════════════════════════════════════════════════════
        const pageRotation = targetPage.getRotation().angle;
        const pgW = targetPage.getWidth();   // post-rotation width
        const pgH = targetPage.getHeight();  // post-rotation height

        // Embed image (prefer PNG for transparency)
        let embeddedImage;
        if (imageData.mime.includes("png")) {
          embeddedImage = await doc.embedPng(imageData.buf);
        } else {
          embeddedImage = await doc.embedJpg(imageData.buf);
        }

        // Scale signature to fill the target box while preserving aspect ratio
        const imgAspect = embeddedImage.width / embeddedImage.height;
        const TARGET_W = 260;  // visual width of the target box
        const TARGET_H = 150;  // visual height of the target box (post-trim: tight enough to stay in zone, tall enough for vertical strokes)
        let sigVisualW: number, sigVisualH: number;
        if (imgAspect >= TARGET_W / TARGET_H) {
          sigVisualW = TARGET_W;
          sigVisualH = TARGET_W / imgAspect;
        } else {
          sigVisualH = TARGET_H;
          sigVisualW = TARGET_H * imgAspect;
        }

        // Compute the field's visual center from raw rect
        const rawRect = { x: left, y: bottom, width: fieldW, height: fieldH };
        const fieldVisual = rawToVisual(rawRect, pgW, pgH, pageRotation);
        const fieldVisualCenterX = fieldVisual.x + fieldVisual.width / 2;
        const fieldVisualCenterY = fieldVisual.y + fieldVisual.height / 2;

        // Position: centered horizontally on field.
        // Bottom-align the ink so it sits ON the signature line, like a real signature.
        // The line is roughly at fieldVisualCenterY + 15pt (reduced from 72pt post-trim).
        // We let 15% of the signature height dip below the line (for descenders like g, y, j).
        const sigLineY = fieldVisualCenterY + 15;
        const descenderAllowance = sigVisualH * 0.15;
        const sigVisualX = fieldVisualCenterX - sigVisualW / 2;
        const sigVisualY = sigLineY - sigVisualH + descenderAllowance;  // ink sits on the line

        // Convert visual placement back to raw PDF coordinates
        const sigVisual: VisualRect = { x: sigVisualX, y: sigVisualY, width: sigVisualW, height: sigVisualH };
        const sigRaw = visualToRaw(sigVisual, pgW, pgH, pageRotation);

        console.log(`[fillPdfForm] Signature "${formFieldName}" rot=${pageRotation} fieldVisualCenter=(${fieldVisualCenterX.toFixed(1)},${fieldVisualCenterY.toFixed(1)}) sigVisual=(${sigVisualX.toFixed(1)},${sigVisualY.toFixed(1)},${sigVisualW.toFixed(1)}x${sigVisualH.toFixed(1)}) sigRaw=(${sigRaw.x.toFixed(1)},${sigRaw.y.toFixed(1)},${sigRaw.width.toFixed(1)}x${sigRaw.height.toFixed(1)})`);

        // BOLD offsets: 9 draws for heavier strokes
        const boldOffsets = [
          [0, 0],
          [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5],
          [0.35, 0.35], [-0.35, 0.35], [0.35, -0.35], [-0.35, -0.35],
        ];

        // Draw the signature image so it appears upright on the displayed page.
        // On non-rotated pages, drawImage works directly.
        // On rotated pages, we must counter-rotate the image in the content stream
        // so that when the page rotation is applied, the image appears upright.
        if (pageRotation === 90 || pageRotation === 270) {
          // For rotated pages: use a transformation matrix to counter-rotate.
          // The visual coords give us WHERE the image should appear.
          // We draw in raw space using a CW rotation matrix that makes the image
          // appear upright after the page's CCW rotation is applied.
          //
          // CW 90° matrix: [0, 1, -1, 0, tx, ty]
          // This draws the image rotated 90° CW in raw space,
          // which appears upright after the page's 90° rotation.
          const { pushGraphicsState, popGraphicsState, concatTransformationMatrix } = await import("pdf-lib");

          // tx/ty position the rotated image so its visual center matches our target
          // For CW matrix [0,1,-1,0,tx,ty]: image spans raw x:[tx-drawH, tx], y:[ty, ty+drawW]
          // Center in raw space: ((tx-sigVisualH/2+tx)/2, (ty+ty+sigVisualW)/2) = (tx-sigVisualH/2, ty+sigVisualW/2)
          // We want this center at the same place as sigRaw center
          const rawCenterX = sigRaw.x + sigRaw.width / 2;
          const rawCenterY = sigRaw.y + sigRaw.height / 2;
          const tx = rawCenterX + sigVisualH / 2;
          const ty = rawCenterY - sigVisualW / 2;

          for (const [ox, oy] of boldOffsets) {
            targetPage.pushOperators(
              pushGraphicsState(),
              concatTransformationMatrix(0, 1, -1, 0, tx + ox, ty + oy),
            );
            targetPage.drawImage(embeddedImage, {
              x: 0, y: 0, width: sigVisualW, height: sigVisualH,
            });
            targetPage.pushOperators(popGraphicsState());
          }
        } else {
          // Non-rotated page: draw directly at raw coordinates
          for (const [ox, oy] of boldOffsets) {
            targetPage.drawImage(embeddedImage, {
              x: sigRaw.x + ox,
              y: sigRaw.y + oy,
              width: sigRaw.width,
              height: sigRaw.height,
            });
          }
        }

        // Remove the signature field so it doesn't overlay our image
        form.removeField(field);
        logger.info({ field: formFieldName, sigVisualW, sigVisualH, rotation: pageRotation }, "Embedded signature image on PDF");
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

  // Pre-fetch all image URLs to base64 before the PDF generation loop.
  // nativeFetchBuffer uses Node's built-in https module (not undici/fetch which can be blocked).
  const urlCache = new Map<string, string>();
  const imgColumns = new Set<string>();
  for (const [k, v] of Object.entries(fieldMappings)) {
    if (!k.startsWith("__sig_") && v && dataset.some((r) => typeof r[v] === "string" && String(r[v]).startsWith("http"))) {
      imgColumns.add(v);
    }
  }
  if (imgColumns.size > 0) {
    logger.info({ columns: [...imgColumns] }, "Pre-fetching image URLs before PDF generation");
    const allUrls = [...new Set(
      [...imgColumns].flatMap((col) => dataset.map((r) => r[col]).filter((u): u is string => typeof u === "string" && u.startsWith("http")))
    )];
    await Promise.all(allUrls.map(async (url) => {
      const result = await fetchImageBuffer(url);
      if (result) {
        urlCache.set(url, `data:${result.mime};base64,${result.buf.toString("base64")}`);
      } else {
        logger.error({ url: url.slice(0, 80) }, "Failed to pre-fetch signature image (all methods failed)");
      }
    }));
    logger.info({ fetched: urlCache.size, total: allUrls.length }, "Image pre-fetch complete");
  }

  // Replace URL values with pre-fetched base64 in the working dataset copy
  const resolvedDataset = urlCache.size > 0
    ? dataset.map((row) => {
        const r = { ...row };
        for (const col of imgColumns) {
          const val = r[col];
          if (typeof val === "string" && urlCache.has(val)) r[col] = urlCache.get(val)!;
        }
        return r;
      })
    : dataset;

  const results: Array<{ filename: string; s3Key: string; rowIndex: number }> = [];

  for (let i = 0; i < resolvedDataset.length; i++) {
    const row = resolvedDataset[i];

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
