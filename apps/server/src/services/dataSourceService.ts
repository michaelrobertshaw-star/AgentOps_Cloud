/**
 * Data Source Service — execution adapters for external data connectors.
 *
 * Supported sources:
 *   - postgres_db: Execute read-only queries against external PostgreSQL databases
 *   - pdf_docs: Extract text from PDF documents for RAG ingestion
 *
 * These are used to enrich agent knowledge or provide live data context.
 */

import { Pool } from "pg";

// ── PostgreSQL Data Source ───────────────────────────────────────────────────

interface PostgresQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: string[];
}

export async function executePostgresQuery(
  connectionString: string,
  query: string,
  params: unknown[] = [],
): Promise<PostgresQueryResult> {
  // Safety: only allow SELECT queries (read-only)
  const trimmed = query.trim().toUpperCase();
  if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
    throw new Error("Only SELECT queries are allowed on external databases");
  }

  // Block dangerous patterns
  const blocked = [/;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE)/i, /--/, /\/\*/];
  for (const pattern of blocked) {
    if (pattern.test(query)) {
      throw new Error("Query contains blocked SQL patterns");
    }
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000, // 30s max query time
  });

  try {
    const result = await pool.query(query, params);
    return {
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? 0,
      fields: result.fields.map((f) => f.name),
    };
  } finally {
    await pool.end();
  }
}

/**
 * Format query results as a text block suitable for RAG context injection.
 */
export function formatQueryResultAsContext(
  result: PostgresQueryResult,
  sourceName: string,
): string {
  if (result.rowCount === 0) return `[${sourceName}]: No results found.`;

  const header = result.fields.join(" | ");
  const rows = result.rows.map((row) =>
    result.fields.map((f) => String(row[f] ?? "")).join(" | "),
  );

  return `[${sourceName}] Query Results (${result.rowCount} rows):\n${header}\n${rows.join("\n")}`;
}

// ── PDF Text Extraction ─────────────────────────────────────────────────────

/**
 * Extract text from a PDF buffer.
 *
 * Uses a lightweight approach: parse the PDF content streams for text operators.
 * For production use with complex PDFs, consider pdf-parse or pdfjs-dist.
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // Try dynamic import of pdf-parse if available
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    return data.text;
  } catch {
    // Fallback: basic text extraction from PDF binary
    return extractTextFallback(buffer);
  }
}

/**
 * Basic fallback PDF text extraction.
 * Handles simple text-based PDFs by extracting string literals from content streams.
 */
function extractTextFallback(buffer: Buffer): string {
  const text = buffer.toString("latin1");
  const textParts: string[] = [];

  // Extract text between parentheses in PDF content streams (Tj/TJ operators)
  const regex = /\(([^)]*)\)\s*Tj/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const decoded = match[1]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");
    textParts.push(decoded);
  }

  if (textParts.length === 0) {
    throw new Error("Could not extract text from PDF. The file may be image-based or encrypted.");
  }

  return textParts.join(" ");
}

/**
 * Extract text from PDF and ingest into RAG knowledge store.
 */
export async function ingestPdfForAgent(
  agentId: string,
  companyId: string,
  pdfBuffer: Buffer,
  fileName: string,
): Promise<{ text: string; chunksCreated: number }> {
  const { ingestText } = await import("./ragService.js");

  const text = await extractTextFromPdf(pdfBuffer);
  if (!text || text.trim().length < 10) {
    throw new Error("Extracted text is too short or empty");
  }

  console.log(`[dataSourceService] PDF "${fileName}": extracted ${text.length} chars`);

  const result = await ingestText(agentId, companyId, text, {
    source_name: fileName,
    source_type: "pdf",
  });

  return { text, chunksCreated: result.chunksCreated };
}
