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

              // ── Paginated fetch with two strategies ──
              // The iCabbi history API has quirks:
              //  - Returns records oldest-first, ignores date_from/date_to params
              //  - total_available is always the GLOBAL total (~538K), not filtered
              //  - account param changes the offset space (loosely filters server-side)
              //  - Offsets in the account-filtered space != offsets in the global space
              //
              // Strategy A (date-bounded): Binary search + forward scan in GLOBAL offset space
              //   (no account filter), with client-side date + account filtering
              // Strategy B (no dates): Offset jump to newest records with all params

              const requestedLimit = Number(historyParams.limit) || 100;
              const hasDateBounds = !!(cfg.tool_params?.date_from || cfg.tool_params?.date_to);
              const dateFrom = cfg.tool_params?.date_from ? new Date(cfg.tool_params.date_from as string) : null;
              const dateTo = cfg.tool_params?.date_to ? new Date(cfg.tool_params.date_to as string + "T23:59:59Z") : null;
              const accountFilter = cfg.tool_params?.account as string | undefined;
              const ABSOLUTE_MAX = 50_000;
              const WALL_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes
              let pullSuccess = false;

              if (hasDateBounds) {
                // ══════════════════════════════════════════════
                // Strategy A: Date-bounded — binary search + forward scan
                // Uses GLOBAL offset space (no account filter) for consistency
                // ══════════════════════════════════════════════
                const scanParams: Record<string, unknown> = {};
                if (historyParams.status) scanParams.status = historyParams.status;

                // Probe for global total_available
                let totalAvailable = 500_000; // fallback
                const probeResult = await executeTool(toolId, companyId, { ...scanParams, limit: 1 }, agentId, runId);
                if (probeResult.success) {
                  const probeResp = probeResult.response as any;
                  const ta = probeResp?.body?.total_available ?? probeResp?.total_available;
                  if (typeof ta === "number") totalAvailable = ta;
                  console.log(`[WorkspaceExec] Global total_available: ${totalAvailable}`);
                }

                // ── Binary search for date_from offset (16 iterations) ──
                let lo = 0;
                let hi = totalAvailable;
                const targetDate = dateFrom || new Date("2000-01-01");
                console.log(`[WorkspaceExec] Binary searching for offset near ${targetDate.toISOString().slice(0, 10)} (range 0..${hi})`);

                for (let i = 0; i < 16; i++) {
                  const mid = Math.floor((lo + hi) / 2);
                  if (mid === lo) break; // converged
                  const probeExec = await executeTool(toolId, companyId, { ...scanParams, limit: 1, offset: mid }, agentId, runId);
                  if (!probeExec.success) { hi = mid; continue; }
                  const probeRows = extractDataset(probeExec.response);
                  if (probeRows.length === 0) { hi = mid; continue; }
                  const flatProbeRow = flattenObject(probeRows[0] as Record<string, unknown>);
                  const rowDateStr = flatProbeRow["pickup_date"] || flatProbeRow["pickup_time"] || flatProbeRow["date"] || flatProbeRow["created_date"] || flatProbeRow["pickup.date"];
                  if (!rowDateStr) { lo = mid + 1; continue; }
                  const rowDate = new Date(rowDateStr as string);
                  console.log(`[WorkspaceExec] BinSearch i=${i}: offset=${mid} → ${rowDate.toISOString().slice(0, 10)}`);
                  if (rowDate < targetDate) lo = mid + 1;
                  else hi = mid;

                  await db.execute(sql`
                    UPDATE workspace_runs SET step_results = ${JSON.stringify([...stepResults, {
                      stepId: step.id, label: step.label, status: "running",
                      rowCount: 0, duration_ms: Date.now() - stepStartMs,
                      message: `Finding date range: step ${i + 1}/16 (${rowDate.toISOString().slice(0, 10)})`,
                    }])}
                    WHERE id = ${runId}
                  `);
                }

                // Back up a bit to not miss boundary records
                let currentOffset = Math.max(0, lo - 500);
                console.log(`[WorkspaceExec] Binary search done. Forward scan from offset=${currentOffset}`);

                // ── Forward scan with client-side date + account filtering ──
                const SCAN_PAGE = 200;
                const accountPattern = accountFilter
                  ? new RegExp(`\\b${accountFilter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
                  : null;
                const allMatchedRows: Record<string, unknown>[] = [];
                let pageNum = 0;
                let consecutiveAfterRange = 0;

                while (allMatchedRows.length < ABSOLUTE_MAX) {
                  // Wall-clock timeout
                  if (Date.now() - stepStartMs > WALL_TIMEOUT_MS) {
                    console.log(`[WorkspaceExec] Wall timeout (4min) reached with ${allMatchedRows.length} records`);
                    break;
                  }

                  const batchParams = { ...scanParams, limit: SCAN_PAGE, offset: currentOffset };
                  const execResult = await executeTool(toolId, companyId, batchParams, agentId, runId);
                  if (!execResult.success) {
                    if (allMatchedRows.length === 0) {
                      console.error(`[WorkspaceExec] pull_data failed:`, execResult.error);
                      stepResults.push({
                        stepId: step.id, label: step.label, status: "error" as const,
                        rowCount: 0, duration_ms: Date.now() - stepStartMs,
                        message: execResult.error ?? "Pull failed",
                      });
                    }
                    break;
                  }

                  const pageRows = extractDataset(execResult.response);
                  if (pageRows.length === 0) break;
                  pageNum++;

                  let keptCount = 0;
                  let afterRangeCount = 0;
                  for (const row of pageRows) {
                    const flat = flattenObject(row);
                    const dateStr = flat["pickup_date"] || flat["pickup_time"] || flat["date"] || flat["created_date"] || flat["pickup.date"];
                    if (!dateStr) continue;
                    const rowDate = new Date(dateStr as string);
                    if (dateFrom && rowDate < dateFrom) continue;
                    if (dateTo && rowDate > dateTo) { afterRangeCount++; continue; }
                    // Account filter (strict word-boundary match)
                    if (accountPattern) {
                      const ref = String(flat["account.ref"] ?? flat["account_ref"] ?? "");
                      const name = String(flat["account.name"] ?? flat["account_name"] ?? "");
                      if (!accountPattern.test(ref) && !accountPattern.test(name)) continue;
                    }
                    allMatchedRows.push(flat);
                    keptCount++;
                  }

                  console.log(`[WorkspaceExec] Page ${pageNum} (offset=${currentOffset}): ${pageRows.length} raw, ${keptCount} kept, ${afterRangeCount} after range (total: ${allMatchedRows.length})`);

                  // Stop if entire page is past date_to
                  if (afterRangeCount === pageRows.length) {
                    consecutiveAfterRange++;
                    if (consecutiveAfterRange >= 2) {
                      console.log(`[WorkspaceExec] 2 consecutive pages past date_to — stopping`);
                      break;
                    }
                  } else {
                    consecutiveAfterRange = 0;
                  }

                  await db.execute(sql`
                    UPDATE workspace_runs SET step_results = ${JSON.stringify([...stepResults, {
                      stepId: step.id, label: step.label, status: "running",
                      rowCount: allMatchedRows.length, duration_ms: Date.now() - stepStartMs,
                      message: `Scanning: page ${pageNum}, ${allMatchedRows.length} matches so far...`,
                    }])}
                    WHERE id = ${runId}
                  `);

                  currentOffset += pageRows.length;
                  if (pageRows.length < SCAN_PAGE) break; // Last page
                }

                if (allMatchedRows.length > 0) {
                  // Already flattened during scan; reverse for newest-first
                  dataset = allMatchedRows;
                  dataset.reverse();
                  console.log(`[WorkspaceExec] Date-bounded pull: ${dataset.length} records (newest-first) from ${pageNum} pages`);
                  pullSuccess = true;
                }

              } else {
                // ══════════════════════════════════════════════
                // Strategy B: Non-date-bounded — offset jump to newest
                // Uses original params (including account) since offset space is consistent
                // when we jump relative to the same filtered total
                // ══════════════════════════════════════════════
                if (!historyParams.offset) {
                  const probeResult = await executeTool(toolId, companyId, { ...historyParams, limit: 1 }, agentId, runId);
                  if (probeResult.success) {
                    const probeResp = probeResult.response as any;
                    const totalAvailable = probeResp?.body?.total_available ?? probeResp?.total_available;
                    if (typeof totalAvailable === "number" && totalAvailable > requestedLimit) {
                      historyParams.offset = Math.max(0, totalAvailable - requestedLimit);
                      console.log(`[WorkspaceExec] API has ${totalAvailable} total records. Setting offset=${historyParams.offset} to get newest ${requestedLimit}`);
                    }
                  }
                }

                const execResult = await executeTool(toolId, companyId, historyParams, agentId, runId);
                if (execResult.success) {
                  const rawDataset = extractDataset(execResult.response);
                  dataset = rawDataset.map(row => flattenObject(row));
                  dataset.reverse();
                  console.log(`[WorkspaceExec] pull_data extracted ${dataset.length} records (flattened, newest-first)`);

                  // Post-filter: strict account match (API's account param is loose contains)
                  if (accountFilter && dataset.length > 0) {
                    const pattern = new RegExp(`\\b${accountFilter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
                    const before = dataset.length;
                    dataset = dataset.filter(row => {
                      const ref = String(row["account.ref"] ?? row["account_ref"] ?? "");
                      const name = String(row["account.name"] ?? row["account_name"] ?? "");
                      return pattern.test(ref) || pattern.test(name);
                    });
                    if (dataset.length < before) {
                      console.log(`[WorkspaceExec] Post-filter: "${accountFilter}" kept ${dataset.length}/${before}`);
                    }
                  }

                  pullSuccess = true;
                } else {
                  console.error(`[WorkspaceExec] pull_data failed:`, execResult.error);
                }
              }

              // ── Signature enrichment (both strategies) ──
              if (wantSignature && dataset.length > 0) {
                const SIG_CAP = 500;
                const sigSlice = dataset.slice(0, SIG_CAP);
                if (dataset.length > SIG_CAP) {
                  console.log(`[WorkspaceExec] Signature enrichment capped at ${SIG_CAP}/${dataset.length} records`);
                }
                console.log(`[WorkspaceExec] Signature enrichment: fetching ${sigSlice.length} bookings...`);

                const sigToolResult = await db.execute(sql`
                  SELECT t.id FROM tools t
                  JOIN connectors c ON c.id = t.connector_id
                  JOIN agent_connectors ac ON ac.connector_id = c.id
                  WHERE ac.agent_id = ${agentId} AND t.name = 'get_booking' AND t.company_id = ${companyId}
                  LIMIT 1
                `);
                const sigToolRows = ((sigToolResult as any).rows ?? sigToolResult) as any[];

                // Ensure payment.signature key exists on ALL rows
                for (const row of dataset) {
                  if (!("payment.signature" in row)) row["payment.signature"] = null;
                }

                if (sigToolRows.length > 0) {
                  const sigToolId = sigToolRows[0].id;
                  let enriched = 0;
                  let enrichErrors = 0;
                  const SIG_BATCH = 10;

                  for (let bStart = 0; bStart < sigSlice.length; bStart += SIG_BATCH) {
                    const batch = sigSlice.slice(bStart, bStart + SIG_BATCH);
                    await Promise.all(batch.map(async (row) => {
                      const tripId = row["trip_id"] || row["perma_id"] || row["id"];
                      if (!tripId) return;
                      try {
                        const sigResult = await executeTool(sigToolId, companyId, {
                          trip_id: String(tripId), signature: true,
                        }, agentId, runId);
                        if (sigResult.success) {
                          const sigData = sigResult.response as any;
                          const booking = sigData?.body?.booking || sigData?.booking || sigData;
                          const sigUrl = booking?.payment?.signature;
                          row["payment.signature"] = sigUrl ?? null;
                          if (sigUrl) enriched++;
                        }
                      } catch { enrichErrors++; }
                    }));

                    const done = Math.min(bStart + SIG_BATCH, sigSlice.length);
                    await db.execute(sql`
                      UPDATE workspace_runs SET step_results = ${JSON.stringify([...stepResults, {
                        stepId: step.id, label: step.label, status: "running",
                        rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
                        message: `Fetching signatures: ${done}/${sigSlice.length} (${enriched} found)...`,
                      }])}
                      WHERE id = ${runId}
                    `);
                  }
                  console.log(`[WorkspaceExec] Signature enrichment: ${enriched} found, ${enrichErrors} errors`);
                } else {
                  console.log(`[WorkspaceExec] WARNING: get_booking tool not found, skipping signature enrichment`);
                }
              }

              stepResults.push({
                stepId: step.id, label: step.label, status: pullSuccess ? "success" : "error",
                rowCount: dataset.length, duration_ms: Date.now() - stepStartMs,
                message: pullSuccess
                  ? `Retrieved ${dataset.length} records${wantSignature ? " (with signatures)" : ""}${hasDateBounds ? ` from ${cfg.tool_params?.date_from} to ${cfg.tool_params?.date_to}` : ""}`
                  : "Pull failed",
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

            // Guard: if dataset is empty, skip PDF generation with a clear message
            if (dataset.length === 0) {
              stepResults.push({
                stepId: step.id, label: step.label, status: "error",
                rowCount: 0, duration_ms: Date.now() - stepStartMs,
                message: "No data rows to generate PDFs from. Check your PULL and PARSE steps.",
              });
              break;
            }

            // Server-side auto-map: if field_mappings are mostly empty or stale, auto-map from dataset columns
            try { if (isFormFill && dataset.length > 0) {
              const realMappings = Object.keys(fieldMappings).filter((k) => !k.startsWith("__sig_"));
              const formFields = (schema?.form_fields ?? []) as Array<{ name: string; type: string }>;
              // Exclude radio fields from coverage — they take static values not column mappings
              const mappableFields = formFields.filter((f) => f.type !== "radio");
              const dataColumns = Object.keys(dataset[0]);

              // Check how many existing mappings actually resolve to real dataset columns
              const validMappings = realMappings.filter((k) => {
                const col = fieldMappings[k];
                return col && (col.startsWith("__static:") || dataColumns.includes(col));
              });
              const coverage = mappableFields.length > 0 ? validMappings.length / mappableFields.length : 1;

              if (coverage < 0.5) {
                console.log("[WorkspaceExec] Low valid field mapping coverage, auto-mapping...", {
                  coverage, validMappings: validMappings.length, totalMappings: realMappings.length,
                  mappableFields: mappableFields.length, dataColumns,
                });
                const normalize = (s: string) => s.toLowerCase().replace(/'s\b/g, "").replace(/[_.\s\-\/()#]+/g, "").replace(/[']/g, "");
                const aliases: Record<string, string[]> = {
                  membername: ["name", "passenger_name", "passengername"],
                  membersname: ["name", "passenger_name", "passengername"],
                  drivername: ["driver_name", "driver.name", "drivername"],
                  driversname: ["driver_name", "driver.name", "drivername"],
                  tripdate: ["pickup_date", "pickup_time", "pickuptime", "pickupdate", "created_date"],
                  pickupaddress: ["pickup_address", "address.formatted", "addressformatted"],
                  pickupstreetaddresscitystatezip: ["pickup_address", "address.formatted", "addressformatted"],
                  dropoffaddress: ["dropoff_address", "destination.formatted", "destinationformatted"],
                  dropoffdestinationstreetaddresscitystatezip: ["dropoff_address", "destination.formatted", "destinationformatted"],
                  memberhealthfirstcoloradoid: ["account.name", "account_name", "account_reference", "accountreference"],
                  fareamount: ["fare_amount", "fareamount"],
                  distance: ["distance", "distance_miles", "distancemiles"],
                  bookingid: ["booking_id", "trip_id", "bookingid", "tripid"],
                  accountname: ["account_name", "account.name", "accountname"],
                  status: ["status"],
                  // Signature aliases
                  memberssignature: ["payment.signature", "signature_url", "signature"],
                  signature: ["payment.signature", "signature_url", "signature"],
                  driversignature: ["payment.signature", "signature_url", "signature"],
                };
                const usedCols = new Set<string>();
                const sigKeys = Object.fromEntries(Object.entries(fieldMappings).filter(([k]) => k.startsWith("__sig_")));
                const newMappings: Record<string, string> = { ...sigKeys };

                for (const ff of formFields) {
                  if (ff.type === "radio") continue; // Skip radio (static values), but allow signature
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
                  // 3. Substring match (skip for signature fields — too ambiguous)
                  if (!matchCol && ff.type !== "signature") {
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
                `).catch((err: unknown) => {
                  console.error("[WorkspaceExec] Failed to persist auto-mapped field_mappings:", err);
                });
              }
            } } catch (autoMapErr) {
              console.error("[WorkspaceExec] Auto-map failed, proceeding with existing mappings", { err: autoMapErr });
            }

            // Validate: at least one real field mapping exists (not just __sig_ keys)
            const realMappingCount = Object.keys(fieldMappings).filter((k) => !k.startsWith("__sig_")).length;
            if (realMappingCount === 0) {
              console.warn("[WorkspaceExec] No field mappings configured for template", { templateId: cfg.template_id });
              stepResults.push({
                stepId: step.id, label: step.label, status: "error",
                rowCount: 0, duration_ms: Date.now() - stepStartMs,
                message: "No field mappings configured. Open the Template Designer and map PDF fields to data columns.",
              });
              break;
            }

            let pdfResults: Array<{ filename: string; s3Key: string; rowIndex: number }>;
            try {
              console.log("[WorkspaceExec] Starting PDF generation", { isFormFill, realMappingCount, mappingKeys: Object.keys(fieldMappings).filter(k => !k.startsWith("__sig_")), datasetLen: dataset.length });
              if (isFormFill) {
                const { generateBatchFormFillPdfs } = await import("./pdfGenerationService.js");
                pdfResults = await generateBatchFormFillPdfs(
                  tmpl.base_pdf_key,
                  fieldMappings,
                  dataset,
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
