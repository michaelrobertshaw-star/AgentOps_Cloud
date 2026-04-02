/**
 * PDF Generation Service
 * Uses @pdfme/generator to fill PDF templates with data from workspace rows.
 */

import { generate } from "@pdfme/generator";
import { text, image, barcodes } from "@pdfme/schemas";
import type { Template } from "@pdfme/common";
import { downloadWorkspaceFile, uploadWorkspaceFile } from "./storageService.js";
import pino from "pino";

const logger = pino({ name: "pdf-generation" });

// pdfme plugin registry
const plugins = { text, image, ...barcodes };

/**
 * Generate a single PDF from a pdfme template + data row.
 */
/**
 * Resolve a raw value to a pdfme-compatible image content string.
 * pdfme image fields require a base64 data URI (data:image/...;base64,...).
 * - Already a data URI → pass through
 * - URL (http/https) → fetch and convert to data URI
 * - Raw base64 string → prepend data:image/jpeg;base64,
 * - Otherwise → empty string
 */
async function resolveImageValue(val: unknown): Promise<string> {
  if (val === null || val === undefined) return "";
  const str = String(val).trim();
  if (!str) return "";
  if (str.startsWith("data:")) return str;
  if (/^https?:\/\//i.test(str)) {
    try {
      const res = await fetch(str);
      const buf = Buffer.from(await res.arrayBuffer());
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
    const { join } = await import("path");
    const localPath = join(process.cwd(), "uploads/templates", basePdfKey.replace("local:templates/", ""));
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

      // Save to local disk (fallback for dev without S3/MinIO)
      const { mkdirSync, writeFileSync } = await import("fs");
      const { join } = await import("path");
      const outDir = join(process.cwd(), "uploads/runs", companyId, runId);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, filename), pdfBuffer);
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
