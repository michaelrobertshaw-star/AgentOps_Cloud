/**
 * Workspace Pipeline Executor
 *
 * Executes multi-step workflow pipelines asynchronously. Each pipeline step
 * transforms a dataset in sequence: pull_data, filter, transform, sort,
 * aggregate, generate_doc, name_files, etc.
 *
 * Runs are tracked in the workspace_runs table with progress updates,
 * step results, and final output data.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../lib/db.js";
import { executeTool } from "./toolExecutionService.js";

// ================================================================
// Response extraction helpers
// ================================================================

/**
 * Recursively searches a nested response for the first array of objects.
 * Handles API wrappers like iCabbi's { version, code, body: { bookings: [...] } }
 */
function findFirstDataArray(obj: any, depth = 0): any[] | null {
  if (depth > 4 || !obj || typeof obj !== "object") return null;
  const arrayNames = ["bookings", "data", "results", "items", "records", "rows", "entries", "jobs", "trips"];
  for (const name of arrayNames) {
    if (Array.isArray(obj[name]) && obj[name].length > 0 && typeof obj[name][0] === "object") {
      return obj[name];
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
      return v;
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const found = findFirstDataArray(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extracts the dataset from a raw API response.
 * Navigates nested wrappers to find the actual data array.
 */
function extractDataset(response: unknown): Record<string, unknown>[] {
  if (!response || typeof response !== "object") return [];
  // Direct array
  if (Array.isArray(response)) return response as Record<string, unknown>[];
  // Search for nested data array
  const dataArray = findFirstDataArray(response);
  if (dataArray && dataArray.length > 0) return dataArray as Record<string, unknown>[];

  const resp = response as any;

  // Check for API wrapper with explicitly empty data array (e.g. { body: { bookings: [], total: 0 } })
  // This means the API returned zero results — don't treat the wrapper as a record
  const arrayNames = ["bookings", "data", "results", "items", "records", "rows", "entries", "jobs", "trips"];
  for (const name of arrayNames) {
    if (resp?.[name] && Array.isArray(resp[name]) && resp[name].length === 0) return [];
    if (resp?.body?.[name] && Array.isArray(resp.body[name]) && resp.body[name].length === 0) return [];
  }

  // Single-object patterns (booking wrapper)
  if (resp?.body?.booking && typeof resp.body.booking === "object") return [resp.body.booking];
  if (resp?.booking && typeof resp.booking === "object") return [resp.booking];
  // Flat object with many keys = single record
  if (Object.keys(resp).length > 10) return [resp];
  return [resp];
}

// ================================================================
// Types
// ================================================================

interface WorkflowStep {
  id: string;
  order: number;
  type: "action" | "value";
  label: string;
  operation: string;
  config: Record<string, unknown>;
  source_text: string;
}

interface StepResult {
  stepId: string;
  label: string;
  status: "success" | "error" | "skipped";
  rowCount: number;
  duration_ms: number;
  error?: string;
  message?: string;
}

interface SmartQuery {
  resource: string;
  connector_id: string;
  tool_name: string;
  clauses: Array<{
    field: string;
    operator: string;
    value: unknown;
  }>;
  includes: string[];
}

// ================================================================
// Main executor
// ================================================================

export async function executeWorkflowPipeline(
  runId: string,
  workflow: any,
  companyId: string,
  agentId: string,
  options: {
    smartQuery?: SmartQuery;
    csvData?: string[][];
    params?: Record<string, unknown>;
  },
) {
  const db = getDb();
  const startMs = Date.now();
  const pipeline: WorkflowStep[] = workflow.pipeline ?? [];
  const stepResults: StepResult[] = [];
  let dataset: Record<string, unknown>[] = [];
  let generatedFiles: Array<{ filename: string; rowIndex: number }> = [];

  try {
    // ── Handle data source (CSV import) ──────────────────────────
    if (options.csvData && options.csvData.length > 1) {
      const headers = options.csvData[0];
      dataset = options.csvData.slice(1).map(row => {
        const obj: Record<string, unknown> = {};
        headers.forEach((h, i) => { obj[h] = row[i] ?? null; });
        return obj;
      });
      stepResults.push({
        stepId: "csv_import",
        label: "Import CSV Data",
        status: "success",
        rowCount: dataset.length,
        duration_ms: 0,
        message: `Loaded ${dataset.length} rows from CSV`,
      });
    }

    // ── Execute each pipeline step ───────────────────────────────
    for (const step of pipeline) {
      const stepStartMs = Date.now();

      try {
        switch (step.operation) {
          case "pull_data": {
            const cfg = step.config as { tool_name?: string; tool_params?: Record<string, unknown> };
            if (!cfg.tool_name) throw new Error("pull_data step missing tool_name");

            // Load tool ID
            const toolResult = await db.execute(sql`
              SELECT t.id FROM tools t
              JOIN connectors c ON c.id = t.connector_id
              JOIN agent_connectors ac ON ac.connector_id = c.id
              WHERE ac.agent_id = ${agentId} AND t.name = ${cfg.tool_name} AND t.company_id = ${companyId}
              LIMIT 1
            `);
            const toolRows = ((toolResult as any).rows ?? toolResult) as any[];
            if (toolRows.length === 0) throw new Error(`Tool "${cfg.tool_name}" not found on this agent`);

            const toolId = toolRows[0].id;

            if (dataset.length > 0) {
              // Per-row execution (batch lookup pattern)
              const results: Record<string, unknown>[] = [];
              let errors = 0;
              for (let i = 0; i < dataset.length; i++) {
                try {
                  const input = { ...cfg.tool_params, ...dataset[i] };
                  const execResult = await executeTool(toolId, companyId, input, agentId, runId);
                  if (execResult.success) {
                    const responseData = typeof execResult.response === "object" ? execResult.response : {};
                    results.push({ ...dataset[i], ...flattenObject(responseData as Record<string, unknown>) });
                  } else {
                    errors++;
                    results.push({ ...dataset[i], _error: execResult.response });
                  }
                } catch (err) {
                  errors++;
                  results.push({ ...dataset[i], _error: err instanceof Error ? err.message : String(err) });
                }

                // Update progress every 10 rows
                if (i % 10 === 0) {
                  await db.execute(sql`
                    UPDATE workspace_runs SET step_results = ${JSON.stringify([...stepResults, {
                      stepId: step.id, label: step.label, status: "running",
                      rowCount: i + 1, duration_ms: Date.now() - stepStartMs,
                      message: `Processing ${i + 1}/${dataset.length}...`,
                    }])}
                    WHERE id = ${runId}
                  `);
                }
              }
              dataset = results.filter(r => !r._error);
              stepResults.push({
                stepId: step.id, label: step.label, status: "success",
                rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
                message: `Retrieved ${dataset.length} records${errors > 0 ? ` (${errors} errors)` : ""}`,
              });
            } else {
              // Single call (no existing dataset)
              // Strip signature from history params — it's only supported on individual booking lookups
              const historyParams = { ...(cfg.tool_params ?? {}) };
              const wantSignature = !!historyParams.signature;
              delete historyParams.signature;

              // ── "Newest first" offset calculation ──
              // Some APIs (e.g., iCabbi /bookings/history) return data oldest-first
              // and ignore date filter params. We detect this by checking for total_available
              // in the response, then calculate the offset to fetch from the end.
              const requestedLimit = Number(historyParams.limit) || 100;
              if (!historyParams.offset) {
                // Probe call: fetch 1 record to discover total_available
                const probeResult = await executeTool(toolId, companyId, { ...historyParams, limit: 1 }, agentId, runId);
                if (probeResult.success) {
                  const probeResp = probeResult.response as any;
                  const totalAvailable = probeResp?.body?.total_available ?? probeResp?.total_available;
                  if (typeof totalAvailable === "number" && totalAvailable > requestedLimit) {
                    // Offset to get the MOST RECENT records
                    const newestOffset = Math.max(0, totalAvailable - requestedLimit);
                    historyParams.offset = newestOffset;
                    console.log(`[WorkspaceExec] API has ${totalAvailable} total records. Setting offset=${newestOffset} to get newest ${requestedLimit}`);
                  }
                }
              }

              const execResult = await executeTool(toolId, companyId, historyParams, agentId, runId);
              if (execResult.success) {
                const rawDataset = extractDataset(execResult.response);
                // Flatten nested objects so dot-notation keys (account.name, driver.name)
                // match the probed field names used in PARSE/pick steps
                dataset = rawDataset.map(row => flattenObject(row));
                // Reverse so newest are first (API returns oldest-first even at high offset)
                dataset.reverse();
                console.log(`[WorkspaceExec] pull_data extracted ${dataset.length} records (flattened, newest-first) from API response`);

                // ── Signature enrichment ──
                // The history endpoint doesn't return signatures. When signature is requested,
                // fetch each booking individually via get_booking tool with ?signature=true
                if (wantSignature && dataset.length > 0) {
                  console.log(`[WorkspaceExec] Signature enrichment: fetching ${dataset.length} individual bookings...`);
                  const sigToolResult = await db.execute(sql`
                    SELECT t.id FROM tools t
                    JOIN connectors c ON c.id = t.connector_id
                    JOIN agent_connectors ac ON ac.connector_id = c.id
                    WHERE ac.agent_id = ${agentId} AND t.name = 'get_booking' AND t.company_id = ${companyId}
                    LIMIT 1
                  `);
                  const sigToolRows = ((sigToolResult as any).rows ?? sigToolResult) as any[];

                  if (sigToolRows.length > 0) {
                    const sigToolId = sigToolRows[0].id;
                    let enriched = 0;
                    let enrichErrors = 0;

                    // Ensure payment.signature key exists on ALL rows so the column always appears
                    for (const row of dataset) {
                      if (!("payment.signature" in row)) row["payment.signature"] = null;
                    }

                    for (let i = 0; i < dataset.length; i++) {
                      const row = dataset[i];
                      const tripId = row["trip_id"] || row["perma_id"] || row["id"];
                      if (!tripId) continue;

                      try {
                        const sigResult = await executeTool(sigToolId, companyId, {
                          trip_id: String(tripId),
                          signature: true,
                        }, agentId, runId);

                        if (sigResult.success) {
                          const sigData = sigResult.response as any;
                          // Navigate to payment.signature in the individual booking response
                          const booking = sigData?.body?.booking || sigData?.booking || sigData;
                          const sigUrl = booking?.payment?.signature;
                          row["payment.signature"] = sigUrl ?? null; // Always set, even if null
                          if (sigUrl) enriched++;
                        }
                      } catch {
                        enrichErrors++;
                      }

                      // Progress update every 10 rows
                      if (i % 10 === 0) {
                        await db.execute(sql`
                          UPDATE workspace_runs SET step_results = ${JSON.stringify([...stepResults, {
                            stepId: step.id, label: step.label, status: "running",
                            rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
                            message: `Fetching signatures: ${i + 1}/${dataset.length} (${enriched} found)...`,
                          }])}
                          WHERE id = ${runId}
                        `);
                      }
                    }
                    console.log(`[WorkspaceExec] Signature enrichment complete: ${enriched} signatures found, ${enrichErrors} errors`);
                  } else {
                    console.log(`[WorkspaceExec] WARNING: get_booking tool not found, skipping signature enrichment`);
                  }
                }
              } else {
                console.error(`[WorkspaceExec] pull_data failed:`, execResult.error);
              }
              stepResults.push({
                stepId: step.id, label: step.label, status: execResult.success ? "success" : "error",
                rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
                message: execResult.success
                  ? `Retrieved ${dataset.length} records${wantSignature ? " (with signature enrichment)" : ""}`
                  : execResult.error,
              });
            }
            break;
          }

          case "filter": {
            const cfg = step.config as { field?: string; operator?: string; value?: unknown };
            if (!cfg.field || !cfg.operator) throw new Error("filter step missing field or operator");

            const before = dataset.length;
            dataset = dataset.filter(row => {
              const val = row[cfg.field!];
              switch (cfg.operator) {
                case "eq": return val == cfg.value;
                case "neq": return val != cfg.value;
                case "gt": return Number(val) > Number(cfg.value);
                case "gte": return Number(val) >= Number(cfg.value);
                case "lt": return Number(val) < Number(cfg.value);
                case "lte": return Number(val) <= Number(cfg.value);
                case "contains": return String(val ?? "").toLowerCase().includes(String(cfg.value).toLowerCase());
                case "between": {
                  const [min, max] = cfg.value as [unknown, unknown];
                  return Number(val) >= Number(min) && Number(val) <= Number(max);
                }
                default: return true;
              }
            });
            stepResults.push({
              stepId: step.id, label: step.label, status: "success",
              rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
              message: `Filtered: ${before} -> ${dataset.length} rows (${before - dataset.length} removed)`,
            });
            break;
          }

          case "transform": {
            const cfg = step.config as {
              mappings?: Array<{ from: string; to: string; transform?: string }>;
              computed?: Array<{ name: string; expression: string }>;
              pick?: string[];
            };

            dataset = dataset.map(row => {
              let out = { ...row };

              // Pick specific fields (supports dot-notation + parent key expansion)
              if (cfg.pick && cfg.pick.length > 0) {
                const picked: Record<string, unknown> = {};
                const outKeys = Object.keys(out);
                for (const f of cfg.pick) {
                  if (f in out) {
                    // Exact match (e.g., "created_date", "account.name")
                    picked[f] = out[f];
                  } else {
                    // Parent key expansion: "account" matches "account.id", "account.name", etc.
                    const prefix = f + ".";
                    for (const k of outKeys) {
                      if (k.startsWith(prefix)) {
                        picked[k] = out[k];
                      }
                    }
                  }
                }
                // Always preserve signature fields if they exist in the data
                // (signature enrichment adds these regardless of user pick selection)
                for (const k of outKeys) {
                  if (k.toLowerCase().includes("signature") && !(k in picked)) {
                    picked[k] = out[k];
                  }
                }
                out = picked;
              }

              // Rename fields
              if (cfg.mappings) {
                for (const m of cfg.mappings) {
                  if (m.from in out) {
                    out[m.to] = out[m.from];
                    if (m.from !== m.to) delete out[m.from];
                  }
                }
              }

              // Computed fields
              if (cfg.computed) {
                for (const c of cfg.computed) {
                  // Simple null coalescing: "field ?? 'default'"
                  const match = c.expression.match(/^(\w+)\s*\?\?\s*['"](.+)['"]$/);
                  if (match) {
                    out[c.name] = out[match[1]] ?? match[2];
                  } else {
                    out[c.name] = c.expression;
                  }
                }
              }

              return out;
            });

            stepResults.push({
              stepId: step.id, label: step.label, status: "success",
              rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
              message: `Transformed ${dataset.length} rows`,
            });
            break;
          }

          case "sort": {
            const cfg = step.config as { sort_by?: Array<{ field: string; direction: "asc" | "desc" }> };
            if (cfg.sort_by && cfg.sort_by.length > 0) {
              dataset.sort((a, b) => {
                for (const s of cfg.sort_by!) {
                  const va = a[s.field], vb = b[s.field];
                  const cmp = String(va ?? "").localeCompare(String(vb ?? ""), undefined, { numeric: true });
                  if (cmp !== 0) return s.direction === "desc" ? -cmp : cmp;
                }
                return 0;
              });
            }
            stepResults.push({
              stepId: step.id, label: step.label, status: "success",
              rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
              message: `Sorted ${dataset.length} rows`,
            });
            break;
          }

          case "generate_doc": {
            const cfg = step.config as {
              template_id?: string;
              output_format?: string;
              per_row?: boolean;
              filename_pattern?: string;
            };

            if (!cfg.template_id) {
              stepResults.push({
                stepId: step.id, label: step.label, status: "error",
                rowCount: 0, duration_ms: Date.now() - stepStartMs,
                message: "No template selected",
              });
              break;
            }

            // Load template from DB
            const tmplResult = await db.execute(sql`
              SELECT * FROM workspace_templates
              WHERE id = ${cfg.template_id} AND company_id = ${companyId}
              LIMIT 1
            `);
            const tmplRows = ((tmplResult as any).rows ?? tmplResult) as any[];
            if (tmplRows.length === 0) {
              stepResults.push({
                stepId: step.id, label: step.label, status: "error",
                rowCount: 0, duration_ms: Date.now() - stepStartMs,
                message: "Template not found",
              });
              break;
            }

            const tmpl = tmplRows[0];
            if (!tmpl.base_pdf_key) {
              stepResults.push({
                stepId: step.id, label: step.label, status: "error",
                rowCount: 0, duration_ms: Date.now() - stepStartMs,
                message: "Template missing base PDF — open the template designer to upload a PDF",
              });
              break;
            }

            let fieldMappings = (tmpl.field_mappings ?? {}) as Record<string, string>;
            const pattern = cfg.filename_pattern || "{trip_id}-{name}.pdf";

            // Detect mode: form_fill (pdf-lib, preserves original) vs overlay (pdfme)
            const schema = tmpl.pdfme_schema as any;
            const isFormFill = schema?.mode === "form_fill";

            // Server-side auto-map: if field_mappings are mostly empty, auto-map from dataset columns
            try { if (isFormFill && dataset.length > 0) {
              const realMappings = Object.keys(fieldMappings).filter((k) => !k.startsWith("__sig_"));
              const formFields = (schema?.form_fields ?? []) as Array<{ name: string; type: string }>;
              // Exclude radio fields from coverage — they take static values not column mappings
              const fillableFields = formFields.filter((f) => f.type !== "signature" && f.type !== "radio");
              const coverage = fillableFields.length > 0 ? realMappings.length / fillableFields.length : 1;

              if (coverage < 0.3) {
                console.log("[WorkspaceExec] Low field mapping coverage, auto-mapping...", { coverage, realMappings: realMappings.length, fillableFields: fillableFields.length });
                const dataColumns = Object.keys(dataset[0]);
                const normalize = (s: string) => s.toLowerCase().replace(/'s\b/g, "").replace(/[_.\s\-\/()#]+/g, "").replace(/[']/g, "");
                const aliases: Record<string, string[]> = {
                  membername: ["name", "passenger_name", "passengername"],
                  membersname: ["name", "passenger_name", "passengername"],
                  drivername: ["driver_name", "driver.name", "drivername"],
                  driversname: ["driver_name", "driver.name", "drivername"],
                  tripdate: ["pickup_time", "pickup_date", "pickuptime", "pickupdate", "created_date"],
                  pickupaddress: ["pickup_address", "address.formatted", "addressformatted"],
                  pickupstreetaddresscitystatezip: ["pickup_address", "address.formatted", "addressformatted"],
                  dropoffaddress: ["dropoff_address", "destination.formatted", "destinationformatted"],
                  dropoffdestinationstreetaddresscitystatezip: ["dropoff_address", "destination.formatted", "destinationformatted"],
                  memberhealthfirstcoloradoid: ["account_reference", "accountreference"],
                  fareamount: ["fare_amount", "fareamount"],
                  distance: ["distance", "distance_miles", "distancemiles"],
                  bookingid: ["booking_id", "trip_id", "bookingid", "tripid"],
                  accountname: ["account_name", "account.name", "accountname"],
                  status: ["status"],
                };
                const usedCols = new Set<string>();
                const sigKeys = Object.fromEntries(Object.entries(fieldMappings).filter(([k]) => k.startsWith("__sig_")));
                const newMappings: Record<string, string> = { ...sigKeys };

                for (const ff of formFields) {
                  if (ff.type === "signature") continue;
                  const normName = normalize(ff.name);

                  // 1. Exact match
                  let matchCol = dataColumns.find((c) => !usedCols.has(c) && normalize(c) === normName);
                  // 2. Alias match
                  if (!matchCol && aliases[normName]) {
                    for (const alias of aliases[normName]) {
                      matchCol = dataColumns.find((c) => !usedCols.has(c) && (c === alias || normalize(c) === normalize(alias)));
                      if (matchCol) break;
                    }
                  }
                  // 3. Substring match
                  if (!matchCol) {
                    matchCol = dataColumns.find((c) => !usedCols.has(c) && normalize(c).length > 2 && (normName.includes(normalize(c)) || normalize(c).includes(normName)));
                  }
                  if (matchCol) {
                    newMappings[ff.name] = matchCol;
                    usedCols.add(matchCol);
                  }
                }

                const newRealMappings = Object.keys(newMappings).filter((k) => !k.startsWith("__sig_"));
                console.log("[WorkspaceExec] Auto-mapped fields", { newMappings: newRealMappings.length, mappings: JSON.stringify(newMappings) });
                fieldMappings = newMappings;

                // Persist auto-mappings to DB
                db.execute(sql`
                  UPDATE workspace_templates SET field_mappings = ${JSON.stringify(fieldMappings)}, updated_at = NOW()
                  WHERE id = ${cfg.template_id} AND company_id = ${companyId}
                `).catch(() => {});
              }
            } } catch (autoMapErr) {
              console.error("[WorkspaceExec] Auto-map failed, proceeding with existing mappings", { err: autoMapErr });
            }

            let pdfResults: Array<{ filename: string; s3Key: string; rowIndex: number }>;
            try {
              // Pre-resolve image URLs to base64 data URIs for all signature field columns.
              // This avoids HTTP fetches inside the tight per-row PDF generation loop (which can fail if
              // the PDF generator runs in a restricted environment or if URLs expire mid-batch).
              let resolvedDataset = dataset;
              if (isFormFill) {
                const sigColumns = new Set<string>();
                for (const [k, v] of Object.entries(fieldMappings)) {
                  if (!k.startsWith("__sig_") && v) {
                    // Check if any row has an http URL for this column (likely a presigned image URL)
                    const sample = dataset.find((r) => typeof r[v] === "string" && String(r[v]).startsWith("http"));
                    if (sample) sigColumns.add(v);
                  }
                }
                if (sigColumns.size > 0) {
                  // Fetch unique URLs to base64
                  const urlCache = new Map<string, string>();
                  for (const col of sigColumns) {
                    const urls = [...new Set(dataset.map((r) => r[col]).filter((u): u is string => typeof u === "string" && u.startsWith("http")))];
                    console.log(`[WorkspaceExec] Pre-fetching ${urls.length} image URLs for column "${col}"`);
                    await Promise.all(urls.map(async (url) => {
                      try {
                        // Use native https.get to avoid undici/fetch network restrictions
                        const { buf, mime, status } = await new Promise<{ buf: Buffer; mime: string; status: number }>((resolve, reject) => {
                          const https = require("https");
                          const http = require("http");
                          const parsed = new URL(url);
                          const lib = parsed.protocol === "https:" ? https : http;
                          const req = lib.get(url, (res: any) => {
                            const chunks: Buffer[] = [];
                            res.on("data", (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
                            res.on("end", () => resolve({ buf: Buffer.concat(chunks), mime: res.headers["content-type"] || "image/png", status: res.statusCode ?? 0 }));
                            res.on("error", reject);
                          });
                          req.setTimeout(12000, () => { req.destroy(); reject(new Error("timeout")); });
                          req.on("error", reject);
                        });
                        if (status >= 200 && status < 300 && buf.length > 0) {
                          urlCache.set(url, `data:${mime};base64,${buf.toString("base64")}`);
                          console.log(`[WorkspaceExec] Pre-fetched image: ${mime}, ${buf.length} bytes, status ${status}`);
                        } else {
                          console.error(`[WorkspaceExec] Failed to pre-fetch image (HTTP ${status}): ${url.slice(0, 80)}`);
                        }
                      } catch (err) {
                        console.error(`[WorkspaceExec] Error pre-fetching image: ${err}. URL: ${url.slice(0, 80)}`);
                      }
                    }));
                  }
                  // Replace URLs with base64 in the dataset
                  if (urlCache.size > 0) {
                    resolvedDataset = dataset.map((row) => {
                      const newRow = { ...row };
                      for (const col of sigColumns) {
                        const url = newRow[col];
                        if (typeof url === "string" && urlCache.has(url)) {
                          newRow[col] = urlCache.get(url)!;
                        }
                      }
                      return newRow;
                    });
                    console.log(`[WorkspaceExec] Pre-resolved ${urlCache.size} unique image URLs to base64`);
                  }
                }
              }

              console.log("[WorkspaceExec] Starting PDF generation", { isFormFill, mappingKeys: Object.keys(fieldMappings).filter(k => !k.startsWith("__sig_")), datasetLen: dataset.length });
              if (isFormFill) {
                const { generateBatchFormFillPdfs } = await import("./pdfGenerationService.js");
                pdfResults = await generateBatchFormFillPdfs(
                  tmpl.base_pdf_key,
                  fieldMappings,
                  resolvedDataset,
                  companyId,
                  runId,
                  pattern,
                );
              } else {
                if (!tmpl.pdfme_schema) {
                  stepResults.push({
                    stepId: step.id, label: step.label, status: "error",
                    rowCount: 0, duration_ms: Date.now() - stepStartMs,
                    message: "Template missing schema — open the template designer to complete setup",
                  });
                  break;
                }
                const { generateBatchPdfs } = await import("./pdfGenerationService.js");
                pdfResults = await generateBatchPdfs(
                  tmpl.base_pdf_key,
                  tmpl.pdfme_schema,
                  fieldMappings,
                  dataset,
                  companyId,
                  runId,
                  pattern,
                );
              }
            } catch (pdfErr: any) {
              console.error("[WorkspaceExec] PDF generation failed", { err: pdfErr, stack: pdfErr?.stack });
              stepResults.push({
                stepId: step.id, label: step.label, status: "error",
                rowCount: 0, duration_ms: Date.now() - stepStartMs,
                message: `PDF generation error: ${pdfErr?.message ?? String(pdfErr)}`,
              });
              break;
            }

            generatedFiles = pdfResults.map((r) => ({
              filename: r.filename,
              rowIndex: r.rowIndex,
            }));

            // Add PDF links to dataset rows
            for (const r of pdfResults) {
              if (r.s3Key && dataset[r.rowIndex]) {
                dataset[r.rowIndex]["_pdf_file"] = r.filename;
                dataset[r.rowIndex]["_pdf_key"] = r.s3Key;
              }
            }

            const successCount = pdfResults.filter((r) => r.s3Key).length;
            stepResults.push({
              stepId: step.id, label: step.label,
              status: successCount > 0 ? "success" : "error",
              rowCount: successCount, duration_ms: Date.now() - stepStartMs,
              message: `Generated ${successCount}/${dataset.length} PDFs`,
            });
            break;
          }

          case "name_files": {
            const cfg = step.config as { pattern?: string };
            if (cfg.pattern) {
              generatedFiles = dataset.map((row, idx) => {
                let filename = cfg.pattern!;
                // Replace {field} placeholders with optional transform and padding
                filename = filename.replace(/\{(\w+)(?:\|(\w+))?(?::(\d+))?\}/g, (_m, field, transform, pad) => {
                  let val = String(row[field] ?? field);
                  if (transform === "upper") val = val.toUpperCase();
                  else if (transform === "lower") val = val.toLowerCase();
                  if (pad) val = val.padStart(Number(pad), "0");
                  return val;
                });
                // Replace {sequence} with index
                filename = filename.replace(/\{sequence(?:\|pad:(\d+))?\}/g, (_m, pad) => {
                  const s = String(idx + 1);
                  return pad ? s.padStart(Number(pad), "0") : s;
                });
                return { filename, rowIndex: idx };
              });
            }
            stepResults.push({
              stepId: step.id, label: step.label, status: "success",
              rowCount: generatedFiles.length, duration_ms: Date.now() - stepStartMs,
              message: `Named ${generatedFiles.length} files`,
            });
            break;
          }

          case "aggregate": {
            const cfg = step.config as { group_by?: string; aggregations?: Array<{ field: string; fn: string; as: string }> };
            if (cfg.aggregations) {
              const summary: Record<string, unknown> = {};
              for (const agg of cfg.aggregations) {
                const values = dataset.map(r => Number(r[agg.field] ?? 0));
                switch (agg.fn) {
                  case "sum": summary[agg.as] = values.reduce((a, b) => a + b, 0); break;
                  case "avg": summary[agg.as] = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0; break;
                  case "count": summary[agg.as] = values.length; break;
                  case "min": summary[agg.as] = values.length > 0 ? Math.min(...values) : 0; break;
                  case "max": summary[agg.as] = values.length > 0 ? Math.max(...values) : 0; break;
                }
              }
              // Attach summary as metadata rather than replacing dataset
              dataset = dataset.map(r => ({ ...r, _summary: summary }));
            }
            stepResults.push({
              stepId: step.id, label: step.label, status: "success",
              rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
            });
            break;
          }

          case "create_doc":
          case "custom": {
            // "custom" and "create_doc" are aliases that the AI pipeline generator
            // may produce.  Dispatch based on the step label when possible.
            const lbl = (step.label ?? "").toLowerCase();

            if (
              step.operation === "create_doc" ||
              (lbl.includes("create") && lbl.includes("doc")) ||
              (lbl.includes("generate") && (lbl.includes("pdf") || lbl.includes("doc")))
            ) {
              // Treat as generate_doc – reuse the same config shape
              const cfg = step.config as {
                template_id?: string;
                output_format?: string;
                per_row?: boolean;
                filename_pattern?: string;
              };

              if (!cfg.template_id) {
                stepResults.push({
                  stepId: step.id, label: step.label, status: "error",
                  rowCount: 0, duration_ms: Date.now() - stepStartMs,
                  message: "No template selected",
                });
                break;
              }

              const tmplResult2 = await db.execute(sql`
                SELECT * FROM workspace_templates
                WHERE id = ${cfg.template_id} AND company_id = ${companyId}
                LIMIT 1
              `);
              const tmplRows2 = ((tmplResult2 as any).rows ?? tmplResult2) as any[];
              if (tmplRows2.length === 0) {
                stepResults.push({
                  stepId: step.id, label: step.label, status: "error",
                  rowCount: 0, duration_ms: Date.now() - stepStartMs,
                  message: "Template not found",
                });
                break;
              }

              const tmpl2 = tmplRows2[0];
              if (!tmpl2.base_pdf_key) {
                stepResults.push({
                  stepId: step.id, label: step.label, status: "error",
                  rowCount: 0, duration_ms: Date.now() - stepStartMs,
                  message: "Template missing base PDF — open the template designer to upload a PDF",
                });
                break;
              }

              const fieldMappings2 = (tmpl2.field_mappings ?? {}) as Record<string, string>;
              const pattern2 = cfg.filename_pattern || "{trip_id}-{name}.pdf";
              const schema2 = tmpl2.pdfme_schema as any;
              const isFormFill2 = schema2?.mode === "form_fill";

              let pdfResults2: Array<{ filename: string; s3Key: string; rowIndex: number }>;
              if (isFormFill2) {
                const { generateBatchFormFillPdfs } = await import("./pdfGenerationService.js");
                pdfResults2 = await generateBatchFormFillPdfs(
                  tmpl2.base_pdf_key, fieldMappings2, dataset, companyId, runId, pattern2,
                );
              } else {
                if (!tmpl2.pdfme_schema) {
                  stepResults.push({
                    stepId: step.id, label: step.label, status: "error",
                    rowCount: 0, duration_ms: Date.now() - stepStartMs,
                    message: "Template missing schema — open the template designer to complete setup",
                  });
                  break;
                }
                const { generateBatchPdfs } = await import("./pdfGenerationService.js");
                pdfResults2 = await generateBatchPdfs(
                  tmpl2.base_pdf_key, tmpl2.pdfme_schema, fieldMappings2, dataset, companyId, runId, pattern2,
                );
              }

              generatedFiles = pdfResults2.map((r) => ({
                filename: r.filename,
                rowIndex: r.rowIndex,
              }));

              for (const r of pdfResults2) {
                if (r.s3Key && dataset[r.rowIndex]) {
                  dataset[r.rowIndex]["_pdf_file"] = r.filename;
                  dataset[r.rowIndex]["_pdf_key"] = r.s3Key;
                }
              }

              const successCount2 = pdfResults2.filter((r) => r.s3Key).length;
              stepResults.push({
                stepId: step.id, label: step.label,
                status: successCount2 > 0 ? "success" : "error",
                rowCount: successCount2, duration_ms: Date.now() - stepStartMs,
                message: `Generated ${successCount2}/${dataset.length} PDFs`,
              });
            } else if (lbl.includes("save") || lbl.includes("export") || lbl.includes("upload")) {
              // Save/export step — files are already persisted during generate_doc.
              // Mark as success so the run result isn't confusing.
              stepResults.push({
                stepId: step.id, label: step.label, status: "success",
                rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
                message: generatedFiles.length > 0
                  ? `${generatedFiles.length} files ready`
                  : "No files to save (run a generate step first)",
              });
            } else {
              stepResults.push({
                stepId: step.id, label: step.label, status: "skipped",
                rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
                message: `Unrecognized custom step: ${step.label}`,
              });
            }
            break;
          }

          default: {
            stepResults.push({
              stepId: step.id, label: step.label, status: "skipped",
              rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
              message: `Unknown operation: ${step.operation}`,
            });
          }
        }
      } catch (stepErr) {
        stepResults.push({
          stepId: step.id, label: step.label, status: "error",
          rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
          error: stepErr instanceof Error ? stepErr.message : String(stepErr),
        });
      }
    }

    // ── Generate AI Notes ────────────────────────────────────────
    let aiNotes = "";
    try {
      aiNotes = generateAiNotes(dataset, stepResults, generatedFiles);
    } catch { /* silent */ }

    // ── Infer columns from dataset ───────────────────────────────
    const columns = inferColumns(dataset);

    // ── Save completed run ───────────────────────────────────────
    const durationMs = Date.now() - startMs;
    await db.execute(sql`
      UPDATE workspace_runs SET
        status = 'completed',
        step_results = ${JSON.stringify(stepResults)},
        output_data = ${JSON.stringify(dataset.slice(0, 1000))},
        output_columns = ${JSON.stringify(columns)},
        ai_notes = ${aiNotes},
        generated_files = ${JSON.stringify(generatedFiles)},
        rows_processed = ${dataset.length},
        files_generated = ${generatedFiles.length},
        duration_ms = ${durationMs},
        completed_at = NOW()
      WHERE id = ${runId}
    `);

    // Update workflow last_run_at
    await db.execute(sql`
      UPDATE workspace_workflows SET last_run_at = NOW(), updated_at = NOW()
      WHERE id = ${workflow.id}
    `);

  } catch (err) {
    const durationMs = Date.now() - startMs;
    await db.execute(sql`
      UPDATE workspace_runs SET
        status = 'failed',
        step_results = ${JSON.stringify(stepResults)},
        error = ${err instanceof Error ? err.message : String(err)},
        duration_ms = ${durationMs},
        completed_at = NOW()
      WHERE id = ${runId}
    `);
  }
}

// ================================================================
// Helpers
// ================================================================

function flattenObject(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, path));
    } else {
      result[path] = value;
    }
  }
  return result;
}

function inferColumns(dataset: Record<string, unknown>[]): Array<{ key: string; label: string; type: string; sortable: boolean }> {
  if (dataset.length === 0) return [];
  const sample = dataset[0];
  return Object.keys(sample)
    .filter(k => !k.startsWith("_"))
    .map(key => {
      const val = sample[key];
      let type = "string";
      if (typeof val === "number") type = "number";
      else if (typeof val === "boolean") type = "boolean";
      else if (typeof val === "string" && !isNaN(Date.parse(val)) && key.toLowerCase().includes("date")) type = "date";

      return {
        key,
        label: key.replace(/[_.]/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        type,
        sortable: true,
      };
    });
}

function generateAiNotes(
  dataset: Record<string, unknown>[],
  stepResults: StepResult[],
  files: Array<{ filename: string; rowIndex: number }>,
): string {
  const notes: string[] = [];

  // Summary
  notes.push(`Summary:`);
  notes.push(`- ${dataset.length} rows in final output`);
  notes.push(`- ${files.length} files generated`);

  // Step results
  const errors = stepResults.filter(s => s.status === "error");
  if (errors.length > 0) {
    notes.push(`\nIssues:`);
    for (const e of errors) {
      notes.push(`- Step "${e.label}" failed: ${e.error}`);
    }
  }

  // Data observations
  const nullCounts: Record<string, number> = {};
  for (const row of dataset) {
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined || v === "") {
        nullCounts[k] = (nullCounts[k] ?? 0) + 1;
      }
    }
  }
  const significantNulls = Object.entries(nullCounts).filter(([, c]) => c > 0);
  if (significantNulls.length > 0) {
    notes.push(`\nMissing Data:`);
    for (const [field, count] of significantNulls) {
      notes.push(`- ${field}: ${count} rows have missing values`);
    }
  }

  return notes.join("\n");
}
