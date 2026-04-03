/**
 * Agent Workspace Routes — Pipeline parsing, workflow CRUD, execution, templates, field discovery
 *
 * Agent-scoped routes (mounted at /api/agents):
 *   POST   /:agentId/workspace/parse                — Parse natural language into pipeline
 *   POST   /:agentId/workspace/workflows             — Create workflow
 *   GET    /:agentId/workspace/workflows             — List workflows
 *   GET    /:agentId/workspace/workflows/:id         — Get single workflow
 *   PATCH  /:agentId/workspace/workflows/:id         — Update workflow
 *   DELETE /:agentId/workspace/workflows/:id         — Delete workflow
 *   POST   /:agentId/workspace/workflows/:id/run     — Execute workflow
 *   GET    /:agentId/workspace/runs                  — List runs
 *   GET    /:agentId/workspace/runs/:runId           — Get run detail (polling)
 *   GET    /:agentId/workspace/fields                — Get available fields for query builder
 *
 * Template routes (mounted at /api/workspace):
 *   GET    /templates                                — List templates
 *   POST   /templates                                — Create template
 *   DELETE /templates/:id                            — Delete template
 */

import { Router } from "express";
import { sql, type SQL } from "drizzle-orm";
import { authenticate } from "../middleware/auth.js";
import { getDb } from "../lib/db.js";

// ================================================================
// Agent-scoped workspace routes
// ================================================================

export function agentWorkspaceRoutes() {
  const router = Router({ mergeParams: true });

  // ── Parse natural language into pipeline ─────────────────────
  // POST /api/agents/:agentId/workspace/parse
  router.post(
    "/:agentId/workspace/parse",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { agentId } = req.params;
        const { input } = req.body;

        if (!input || typeof input !== "string") {
          return res.status(400).json({ error: "input is required" });
        }

        // Load agent's tools for context
        const toolsResult = await db.execute(sql`
          SELECT t.name, t.display_name, t.description, t.input_schema, t.response_mapping, t.http_method, t.endpoint_path
          FROM tools t
          JOIN connectors c ON c.id = t.connector_id
          JOIN agent_connectors ac ON ac.connector_id = c.id
          WHERE ac.agent_id = ${agentId} AND t.company_id = ${companyId} AND t.enabled = true
        `);
        const tools = ((toolsResult as any).rows ?? toolsResult) as any[];

        // Build the parse prompt
        const systemPrompt = `You are a workflow pipeline parser. Given natural language, extract a structured multi-step pipeline.

Available tools for this agent:
${JSON.stringify(tools.map(t => ({
  name: t.name,
  display_name: t.display_name,
  description: t.description,
  input_schema: t.input_schema,
  response_fields: t.response_mapping ? Object.values(t.response_mapping) : [],
})), null, 2)}

Return a JSON object with:
{
  "pipeline": [
    {
      "id": "step_1",
      "order": 1,
      "type": "action" or "value",
      "label": "human readable label",
      "operation": one of: "pull_data", "filter", "transform", "sort", "group", "aggregate", "generate_doc", "name_files", "merge", "deduplicate", "enrich", "custom",
      "config": { operation-specific config },
      "source_text": "the part of user input this step came from"
    }
  ],
  "readable": "A plain English summary of the full pipeline"
}

Step type rules:
- "action" (green) = actively does something: pull data, create, generate, sort, save, transform
- "value" (red) = passive filtering/selection: field conditions, thresholds, includes/excludes

For pull_data: config needs { tool_name, tool_params }
For filter: config needs { field, operator (eq/neq/gt/gte/lt/lte/contains/in/between), value }
For transform: config needs { mappings: [{from, to}], computed: [{name, expression}] }
For sort: config needs { sort_by: [{field, direction}] }
For generate_doc: config needs { template_id, output_format, per_row }
For name_files: config needs { pattern }
For custom: config needs { instruction }

Return ONLY valid JSON, no markdown fences.`;

        // Get API key via the shared helper
        const { loadCompanyDefaultApiKey } = await import("./connectors.js");
        const apiKey = await loadCompanyDefaultApiKey(companyId);

        if (!apiKey) {
          return res
            .status(400)
            .json({ error: "No Anthropic API key configured. Add a claude_api connector." });
        }

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: "user", content: input }],
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          return res.status(502).json({ error: `LLM error: ${errText.slice(0, 300)}` });
        }

        const llmResult = (await response.json()) as any;
        let rawText = llmResult.content?.[0]?.text ?? "";

        // Extract JSON from potential markdown fences
        const jsonMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (jsonMatch) {
          rawText = jsonMatch[1].trim();
        } else {
          const firstBrace = rawText.indexOf("{");
          const lastBrace = rawText.lastIndexOf("}");
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            rawText = rawText.slice(firstBrace, lastBrace + 1);
          }
        }

        let parsed;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          return res.status(500).json({ error: "LLM returned invalid JSON", raw: rawText.slice(0, 500) });
        }

        res.json(parsed);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── CRUD for workflows ───────────────────────────────────────

  // POST /api/agents/:agentId/workspace/workflows — create workflow
  router.post(
    "/:agentId/workspace/workflows",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { agentId } = req.params;
        const { name, description, natural_input, pipeline, config } = req.body;

        if (!name || !natural_input) {
          return res.status(400).json({ error: "name and natural_input are required" });
        }

        const result = await db.execute(sql`
          INSERT INTO workspace_workflows (company_id, agent_id, name, description, natural_input, pipeline, config)
          VALUES (${companyId}, ${agentId}, ${name}, ${description ?? null}, ${natural_input}, ${JSON.stringify(pipeline ?? [])}, ${JSON.stringify(config ?? {})})
          RETURNING *
        `);
        const rows = ((result as any).rows ?? result) as any[];
        res.status(201).json(rows[0]);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/agents/:agentId/workspace/workflows — list workflows
  router.get(
    "/:agentId/workspace/workflows",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { agentId } = req.params;

        const result = await db.execute(sql`
          SELECT id, name, description, status, last_run_at, created_at, updated_at,
                 jsonb_array_length(pipeline) as step_count
          FROM workspace_workflows
          WHERE company_id = ${companyId} AND agent_id = ${agentId}
            AND name != '__step_test__'
          ORDER BY updated_at DESC
        `);
        const rows = ((result as any).rows ?? result) as any[];
        res.json(rows);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/agents/:agentId/workspace/workflows/:id — get single workflow
  router.get(
    "/:agentId/workspace/workflows/:id",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { id } = req.params;

        const result = await db.execute(sql`
          SELECT * FROM workspace_workflows
          WHERE id = ${id} AND company_id = ${companyId}
        `);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0) return res.status(404).json({ error: "Workflow not found" });
        res.json(rows[0]);
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH /api/agents/:agentId/workspace/workflows/:id — update workflow
  router.patch(
    "/:agentId/workspace/workflows/:id",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { id } = req.params;
        const { name, description, pipeline, config, status, natural_input } = req.body;

        const setClauses: SQL[] = [];

        if (name !== undefined) setClauses.push(sql`name = ${name}`);
        if (description !== undefined) setClauses.push(sql`description = ${description}`);
        if (natural_input !== undefined) setClauses.push(sql`natural_input = ${natural_input}`);
        if (pipeline !== undefined) setClauses.push(sql`pipeline = ${JSON.stringify(pipeline)}`);
        if (config !== undefined) setClauses.push(sql`config = ${JSON.stringify(config)}`);
        if (status !== undefined) setClauses.push(sql`status = ${status}`);
        setClauses.push(sql`updated_at = now()`);

        if (setClauses.length <= 1) return res.status(400).json({ error: "No fields to update" });

        const setFragment = sql.join(setClauses, sql`, `);
        const result = await db.execute(sql`UPDATE workspace_workflows SET ${setFragment} WHERE id = ${id} AND company_id = ${companyId} RETURNING *`);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0) return res.status(404).json({ error: "Workflow not found" });
        res.json(rows[0]);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/agents/:agentId/workspace/workflows/:id
  router.delete(
    "/:agentId/workspace/workflows/:id",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { id } = req.params;
        await db.execute(sql`DELETE FROM workspace_workflows WHERE id = ${id} AND company_id = ${companyId}`);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Execute workflow ─────────────────────────────────────────

  // POST /api/agents/:agentId/workspace/workflows/:id/run — execute workflow
  router.post(
    "/:agentId/workspace/workflows/:id/run",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const agentId = req.params.agentId as string;
        const id = req.params.id as string;
        const { params: inputParams, query: smartQuery, csvData } = req.body;

        // Load workflow
        const wfResult = await db.execute(sql`
          SELECT * FROM workspace_workflows WHERE id = ${id} AND company_id = ${companyId}
        `);
        const wfRows = ((wfResult as any).rows ?? wfResult) as any[];
        if (wfRows.length === 0) return res.status(404).json({ error: "Workflow not found" });
        const workflow = wfRows[0];

        // Create run record
        const runResult = await db.execute(sql`
          INSERT INTO workspace_runs (workflow_id, company_id, agent_id, status, input_params)
          VALUES (${id}, ${companyId}, ${agentId}, ${"running"}, ${JSON.stringify(inputParams ?? {})})
          RETURNING *
        `);
        const runRows = ((runResult as any).rows ?? runResult) as any[];
        const run = runRows[0];

        // Execute pipeline asynchronously
        const { executeWorkflowPipeline } = await import("../services/workspaceExecutor.js");

        // Fire and forget — runs in background
        executeWorkflowPipeline(run.id, workflow, companyId, agentId, {
          smartQuery,
          csvData,
          params: inputParams,
        }).catch(err => {
          console.error(`[Workspace] Run ${run.id} failed:`, err);
        });

        res.status(202).json({ runId: run.id, status: "running" });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Runs ───────────────────────────────────────────────────

  // GET /api/agents/:agentId/workspace/runs — list runs
  router.get(
    "/:agentId/workspace/runs",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { agentId } = req.params;

        const result = await db.execute(sql`
          SELECT r.*, w.name as workflow_name
          FROM workspace_runs r
          LEFT JOIN workspace_workflows w ON w.id = r.workflow_id
          WHERE r.company_id = ${companyId} AND r.agent_id = ${agentId}
          ORDER BY r.started_at DESC
          LIMIT 50
        `);
        const rows = ((result as any).rows ?? result) as any[];
        res.json(rows);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/agents/:agentId/workspace/runs/:runId — get run detail (for polling)
  router.get(
    "/:agentId/workspace/runs/:runId",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { runId } = req.params;

        const result = await db.execute(sql`
          SELECT * FROM workspace_runs WHERE id = ${runId} AND company_id = ${companyId}
        `);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0) return res.status(404).json({ error: "Run not found" });
        res.json(rows[0]);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Test step (inline execution, no DB run record) ──────────

  // POST /api/agents/:agentId/workspace/test-step
  // Body: { pipeline: WorkflowStep[] }
  // Runs the given pipeline synchronously and returns raw data + step results.
  // Used by the "Test" button on each step card to preview data at that point.
  router.post(
    "/:agentId/workspace/test-step",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const agentId = req.params.agentId as string;
        const { pipeline } = req.body;

        if (!Array.isArray(pipeline) || pipeline.length === 0) {
          return res.status(400).json({ error: "pipeline is required" });
        }

        const { executeWorkflowPipeline } = await import("../services/workspaceExecutor.js");

        // Create a temporary workflow + run record, execute, return result, clean up
        const tempWfResult = await db.execute(sql`
          INSERT INTO workspace_workflows (company_id, agent_id, name, description, natural_input, pipeline, config)
          VALUES (${companyId}, ${agentId}, ${"__step_test__"}, ${"Temporary step test"}, ${"Step test"}, ${JSON.stringify(pipeline)}, ${JSON.stringify({})})
          RETURNING *
        `);
        const tempWfRows = ((tempWfResult as any).rows ?? tempWfResult) as any[];
        const tempWf = tempWfRows[0];

        let runId: string | null = null;
        try {
          const runResult = await db.execute(sql`
            INSERT INTO workspace_runs (workflow_id, company_id, agent_id, status, input_params)
            VALUES (${tempWf.id}, ${companyId}, ${agentId}, ${"running"}, ${JSON.stringify({})})
            RETURNING *
          `);
          const runRows = ((runResult as any).rows ?? runResult) as any[];
          runId = runRows[0].id;

          // Execute synchronously
          await executeWorkflowPipeline(runId!, tempWf, companyId, agentId, {});

          // Fetch the completed run
          const completedResult = await db.execute(sql`
            SELECT * FROM workspace_runs WHERE id = ${runId}
          `);
          const completedRows = ((completedResult as any).rows ?? completedResult) as any[];
          const completedRun = completedRows[0];

          res.json({
            status: completedRun?.status ?? "unknown",
            step_results: completedRun?.step_results ?? [],
            output_data: completedRun?.output_data ?? null,
            output_columns: completedRun?.output_columns ?? null,
            rows_processed: completedRun?.rows_processed ?? 0,
            duration_ms: completedRun?.duration_ms ?? null,
            error: completedRun?.error ?? null,
            run_id: runId,
          });
        } finally {
          // NOTE: We do NOT delete the temp workflow here because
          // workspace_runs has ON DELETE CASCADE on workflow_id —
          // deleting the workflow would also nuke the run record,
          // breaking PDF preview. The temp workflow is tiny and
          // can be cleaned up by a periodic job later.
        }
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Query builder field discovery ────────────────────────────

  // GET /api/agents/:agentId/workspace/fields — get available fields for query builder
  router.get(
    "/:agentId/workspace/fields",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { agentId } = req.params;

        // Load tools attached to this agent
        const toolsResult = await db.execute(sql`
          SELECT t.id, t.name, t.display_name, t.description, t.input_schema, t.response_mapping,
                 c.name as connector_name, c.id as connector_id
          FROM tools t
          JOIN connectors c ON c.id = t.connector_id
          JOIN agent_connectors ac ON ac.connector_id = c.id
          WHERE ac.agent_id = ${agentId} AND t.company_id = ${companyId} AND t.enabled = true
        `);
        const tools = ((toolsResult as any).rows ?? toolsResult) as any[];

        // Build field definitions for the query builder
        const resources = tools.map(tool => {
          const inputSchema = tool.input_schema ?? {};
          const responseMapping = tool.response_mapping ?? {};
          const properties = inputSchema.properties ?? {};

          // Extract fields from input_schema
          const fields = Object.entries(properties).map(([key, schema]: [string, any]) => {
            let fieldType = "string";
            if (schema.type === "number" || schema.type === "integer") fieldType = "number";
            else if (schema.enum) fieldType = "enum";
            else if (key.toLowerCase().includes("date") || key.toLowerCase().includes("time")) fieldType = "date";
            else if (schema.type === "boolean") fieldType = "boolean";

            return {
              key,
              label: schema.description || key.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
              description: schema.description || null,
              type: fieldType,
              enum_values: schema.enum ?? null,
              unit: key.toLowerCase().includes("distance") || key.toLowerCase().includes("miles") ? "miles" :
                    key.toLowerCase().includes("fare") || key.toLowerCase().includes("cost") ? "dollars" : null,
            };
          });

          // Add response fields
          const responseFields = Object.entries(responseMapping).map(([apiPath, friendlyName]: [string, any]) => ({
            key: apiPath,
            label: typeof friendlyName === "string" ? friendlyName : apiPath,
            type: "string",
            source: "response",
          }));

          return {
            tool_id: tool.id,
            tool_name: tool.name,
            display_name: tool.display_name || tool.name.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
            description: tool.description,
            connector_name: tool.connector_name,
            connector_id: tool.connector_id,
            fields,
            response_fields: responseFields,
          };
        });

        res.json(resources);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Sample fetch: probe real API to discover actual response fields ──

  // POST /api/agents/:agentId/workspace/probe
  // Body: { tool_name: string, sample_params?: object }
  // Returns: { fields: [{ key, label, type, sample_value }], raw_sample: object }
  router.post(
    "/:agentId/workspace/probe",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const agentId = req.params.agentId as string;
        const { tool_name, sample_params } = req.body;

        if (!tool_name) {
          return res.status(400).json({ error: "tool_name is required" });
        }

        // Load the tool
        const toolResult = await db.execute(sql`
          SELECT t.id, t.name, t.input_schema
          FROM tools t
          JOIN connectors c ON c.id = t.connector_id
          JOIN agent_connectors ac ON ac.connector_id = c.id
          WHERE ac.agent_id = ${agentId} AND t.company_id = ${companyId}
            AND t.name = ${tool_name} AND t.enabled = true
          LIMIT 1
        `);
        const tools = ((toolResult as any).rows ?? toolResult) as any[];
        if (tools.length === 0) {
          return res.status(404).json({ error: "Tool not found" });
        }

        const tool = tools[0];

        // Build minimal params for a sample fetch (limit to 1 result)
        const inputSchema = tool.input_schema ?? {};
        const props = inputSchema.properties ?? {};
        const minParams: Record<string, unknown> = { ...(sample_params ?? {}) };

        // Try to set a small limit
        for (const key of Object.keys(props)) {
          if (key.toLowerCase().includes("limit") || key.toLowerCase().includes("max") || key.toLowerCase().includes("count")) {
            if (!minParams[key]) minParams[key] = 1;
          }
        }

        // Execute the tool with minimal params
        const { executeTool } = await import("../services/toolExecutionService.js");
        const result = await executeTool(tool.id, companyId, minParams, agentId);

        if (!result.success) {
          return res.status(502).json({ error: "API call failed", detail: result.error });
        }

        // Extract fields from the real response — uses same logic as Bookr batch-lookup
        const response = result.response as any;

        // Navigate into the response to find the data record
        // iCabbi patterns:
        //   List: { body: [ {...}, {...} ] }
        //   Single: { body: { booking: { ...250+ fields... } } }
        //   Error: { version, error: true, code: 404, body: [] }
        let sampleRow: Record<string, unknown> | null = null;

        // Universal array-finder: recursively search for the first array of objects
        // This handles: { body: { bookings: [...] } }, { bookings: [...] }, { data: [...] }, etc.
        function findFirstDataArray(obj: any, depth = 0): any[] | null {
          if (depth > 4 || !obj || typeof obj !== "object") return null;
          // Check known array field names first
          const arrayNames = ["bookings", "data", "results", "items", "records", "rows", "entries", "jobs", "trips"];
          for (const name of arrayNames) {
            if (Array.isArray(obj[name]) && obj[name].length > 0 && typeof obj[name][0] === "object") {
              return obj[name];
            }
          }
          // Check any array field
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
              return v;
            }
          }
          // Recurse into object children
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === "object" && v !== null && !Array.isArray(v)) {
              const found = findFirstDataArray(v, depth + 1);
              if (found) return found;
            }
          }
          return null;
        }

        // 1. Try to find an array of data records anywhere in the response
        const dataArray = findFirstDataArray(response);
        if (dataArray && dataArray.length > 0) {
          sampleRow = dataArray[0];
          // If array items have a booking wrapper, unwrap
          if (sampleRow && typeof (sampleRow as any).booking === "object") {
            sampleRow = (sampleRow as any).booking;
          }
        }

        // 2. If no array found, try direct single-object patterns
        if (!sampleRow) {
          // body.booking (single record lookup)
          if (response?.body?.booking && typeof response.body.booking === "object") {
            sampleRow = response.body.booking;
          }
          // response.booking
          else if (response?.booking && typeof response.booking === "object") {
            sampleRow = response.booking;
          }
          // response is the data itself (flat, many keys)
          else if (typeof response === "object" && response && Object.keys(response).length > 10) {
            sampleRow = response;
          }
        }

        // 3. Fallback: look for any nested object with lots of keys
        if (!sampleRow && typeof response === "object" && response) {
          const arrayFieldNames = ["bookings", "data", "results", "items", "records", "rows", "entries", "jobs", "trips"];
          for (const fieldName of arrayFieldNames) {
            if (Array.isArray(response[fieldName]) && response[fieldName].length > 0) {
              sampleRow = response[fieldName][0];
              break;
            }
          }
          // If still nothing, look for ANY array field with objects in it
          if (!sampleRow) {
            for (const k of Object.keys(response)) {
              const v = response[k];
              if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
                sampleRow = v[0];
                break;
              }
            }
          }
          // Last resort: if no arrays found, check for nested data objects
          if (!sampleRow && !response.error) {
            const wrapperKeys = new Set(["version", "error", "code", "message", "total", "total_available", "max_last_modified", "count", "page"]);
            const dataKeys = Object.keys(response).filter(k => !wrapperKeys.has(k));
            if (dataKeys.length > 5) {
              sampleRow = response;
            } else {
              for (const k of dataKeys) {
                const v = response[k];
                if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 3) {
                  sampleRow = v;
                  break;
                }
              }
            }
          }
        }

        if (!sampleRow || (typeof sampleRow === "object" && Object.keys(sampleRow).length === 0)) {
          return res.json({
            fields: [],
            raw_sample: null,
            message: "Could not extract sample row — API may have returned empty results or an error",
            _debug: {
              keys: typeof response === "object" && response ? Object.keys(response).slice(0, 20) : [],
              snippet: JSON.stringify(response)?.slice(0, 500),
            },
          });
        }

        // Flatten nested objects to get all field paths
        function flattenKeys(obj: Record<string, unknown>, prefix = ""): Array<{ key: string; value: unknown }> {
          const result: Array<{ key: string; value: unknown }> = [];
          for (const [k, v] of Object.entries(obj)) {
            const fullKey = prefix ? `${prefix}.${k}` : k;
            if (v !== null && typeof v === "object" && !Array.isArray(v)) {
              // Add the nested object AND its children
              result.push({ key: fullKey, value: JSON.stringify(v).slice(0, 100) });
              result.push(...flattenKeys(v as Record<string, unknown>, fullKey));
            } else {
              result.push({ key: fullKey, value: v });
            }
          }
          return result;
        }

        const flatFields = flattenKeys(sampleRow);

        // Build field definitions with inferred types
        const fields = flatFields.map(({ key, value }) => {
          let type = "string";
          if (typeof value === "number") type = "number";
          else if (typeof value === "boolean") type = "boolean";
          else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) type = "date";

          // Generate human-readable label
          // For nested keys, include parent context when the leaf name alone is ambiguous
          const parts = key.split(".");
          const leaf = parts[parts.length - 1];
          const ambiguousLeaves = ["formatted", "id", "lat", "lng", "name", "ref", "state", "active", "phone", "ix", "a_k_a", "street", "zipcode", "building_number", "actual_lat", "actual_lng", "year"];
          const useParent = parts.length > 1 && ambiguousLeaves.includes(leaf.toLowerCase());
          const labelParts = useParent ? parts.slice(-2) : [leaf];
          const label = labelParts
            .join(" ")
            .replace(/_/g, " ")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/\b\w/g, (c) => c.toUpperCase());

          return {
            key,
            label,
            type,
            sample_value: value !== null && value !== undefined ? String(value).slice(0, 100) : null,
            unit: key.toLowerCase().includes("distance") || key.toLowerCase().includes("miles") ? "miles" :
                  key.toLowerCase().includes("fare") || key.toLowerCase().includes("cost") || key.toLowerCase().includes("price") ? "dollars" : null,
          };
        });

        res.json({
          fields,
          field_count: fields.length,
          raw_sample: sampleRow,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ================================================================
// Template routes (not agent-scoped)
// ================================================================

export function agentWorkspaceTemplateRoutes() {
  const router = Router();

  // GET /api/workspace/templates — list templates
  router.get(
    "/templates",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;

        const result = await db.execute(sql`
          SELECT * FROM workspace_templates
          WHERE company_id = ${companyId} OR source = 'library'
          ORDER BY is_default DESC, name ASC
        `);
        const rows = ((result as any).rows ?? result) as any[];
        res.json(rows);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/workspace/templates — create template
  router.post(
    "/templates",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { name, description, type, content, variable_schema, tags } = req.body;

        if (!name) {
          return res.status(400).json({ error: "name is required" });
        }

        const result = await db.execute(sql`
          INSERT INTO workspace_templates (company_id, name, description, type, content, variable_schema, source)
          VALUES (${companyId}, ${name}, ${description ?? null}, ${type ?? "pdf"}, ${content ?? ""}, ${JSON.stringify(variable_schema ?? {})}, ${"custom"})
          RETURNING *
        `);
        const rows = ((result as any).rows ?? result) as any[];
        res.status(201).json(rows[0]);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/workspace/templates/:id — single template
  router.get(
    "/templates/:id",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const result = await db.execute(sql`
          SELECT * FROM workspace_templates WHERE id = ${req.params.id} AND company_id = ${companyId} LIMIT 1
        `);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0) return res.status(404).json({ error: "Template not found" });
        res.json(rows[0]);
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH /api/workspace/templates/:id — update template
  router.patch(
    "/templates/:id",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { name, description, pdfme_schema, field_mappings, content } = req.body;

        const result = await db.execute(sql`
          UPDATE workspace_templates SET
            name = COALESCE(${name ?? null}, name),
            description = COALESCE(${description ?? null}, description),
            pdfme_schema = COALESCE(${pdfme_schema ? JSON.stringify(pdfme_schema) : null}::jsonb, pdfme_schema),
            field_mappings = COALESCE(${field_mappings ? JSON.stringify(field_mappings) : null}::jsonb, field_mappings),
            content = COALESCE(${content ?? null}, content),
            updated_at = NOW()
          WHERE id = ${req.params.id} AND company_id = ${companyId}
          RETURNING *
        `);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0) return res.status(404).json({ error: "Template not found" });
        res.json(rows[0]);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/workspace/templates/:id/upload-pdf — upload base PDF for a template
  router.post(
    "/templates/:id/upload-pdf",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const templateId = req.params.id as string;

        // Accept raw PDF body (Content-Type: application/pdf)
        // or base64 JSON body { pdf: "base64..." }
        let pdfBuffer: Buffer;

        const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50 MB

        if (req.headers["content-type"]?.includes("application/pdf")) {
          const chunks: Buffer[] = [];
          let totalSize = 0;
          for await (const chunk of req) {
            const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            totalSize += buf.length;
            if (totalSize > MAX_PDF_SIZE) {
              return res.status(413).json({ error: `PDF too large (max ${MAX_PDF_SIZE / 1024 / 1024}MB)` });
            }
            chunks.push(buf);
          }
          pdfBuffer = Buffer.concat(chunks);
        } else {
          const { pdf } = req.body;
          if (!pdf) return res.status(400).json({ error: "No PDF data provided" });
          // Strip data URL prefix if present
          const b64 = typeof pdf === "string" && pdf.includes(",") ? pdf.split(",")[1] : pdf;
          pdfBuffer = Buffer.from(b64, "base64");
          if (pdfBuffer.length > MAX_PDF_SIZE) {
            return res.status(413).json({ error: `PDF too large (max ${MAX_PDF_SIZE / 1024 / 1024}MB)` });
          }
        }

        if (pdfBuffer.length === 0) {
          return res.status(400).json({ error: "Empty PDF" });
        }

        // Validate PDF magic bytes
        if (!pdfBuffer.subarray(0, 5).toString().startsWith("%PDF-")) {
          return res.status(400).json({ error: "File is not a valid PDF" });
        }

        // Save to local disk (S3 fallback for dev without Docker/MinIO)
        const { mkdirSync, writeFileSync } = await import("fs");
        const { join } = await import("path");
        const uploadsDir = join(process.cwd(), "uploads/templates", companyId, templateId);
        mkdirSync(uploadsDir, { recursive: true });
        const localPath = join(uploadsDir, "base.pdf");
        writeFileSync(localPath, pdfBuffer);
        const localKey = `local:templates/${companyId}/${templateId}/base.pdf`;

        // Extract AcroForm fields (fillable PDF detection)
        const { extractFormFields } = await import("../services/pdfGenerationService.js");
        const formFields = await extractFormFields(pdfBuffer);
        const templateMode = formFields.length > 0 ? "form_fill" : "overlay";

        // Update template record with mode + form fields
        await db.execute(sql`
          UPDATE workspace_templates SET
            base_pdf_key = ${localKey},
            type = 'pdf',
            pdfme_schema = ${JSON.stringify(templateMode === "form_fill" ? { mode: "form_fill", form_fields: formFields } : null)},
            updated_at = NOW()
          WHERE id = ${templateId} AND company_id = ${companyId}
        `);

        res.json({
          ok: true,
          base_pdf_key: localKey,
          size: pdfBuffer.length,
          mode: templateMode,
          form_fields: formFields,
        });
      } catch (err) {
        console.error("[upload-pdf] error:", err);
        next(err);
      }
    },
  );

  // GET /api/workspace/templates/:id/base-pdf — download the base PDF
  router.get(
    "/templates/:id/base-pdf",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;

        const result = await db.execute(sql`
          SELECT base_pdf_key FROM workspace_templates WHERE id = ${req.params.id} AND company_id = ${companyId} LIMIT 1
        `);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0 || !rows[0].base_pdf_key) {
          return res.status(404).json({ error: "No base PDF uploaded" });
        }

        const pdfKey: string = rows[0].base_pdf_key;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="template-${req.params.id}.pdf"`);

        if (pdfKey.startsWith("local:")) {
          const { readFileSync } = await import("fs");
          const path = await import("path");
          const baseDir = path.resolve(process.cwd(), "uploads/templates");
          const localPath = path.resolve(baseDir, pdfKey.replace("local:templates/", ""));
          if (!localPath.startsWith(baseDir + path.sep) && localPath !== baseDir) {
            return res.status(400).json({ error: "Invalid template path" });
          }
          res.send(readFileSync(localPath));
        } else {
          const { downloadWorkspaceFile } = await import("../services/storageService.js");
          const { body } = await downloadWorkspaceFile(pdfKey);
          res.send(body);
        }
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/workspace/templates/:id/preview — generate a preview PDF with sample data
  router.post(
    "/templates/:id/preview",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const { sample_data } = req.body;

        const result = await db.execute(sql`
          SELECT * FROM workspace_templates WHERE id = ${req.params.id} AND company_id = ${companyId} LIMIT 1
        `);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0) return res.status(404).json({ error: "Template not found" });

        const tmpl = rows[0];
        if (!tmpl.base_pdf_key || !tmpl.pdfme_schema) {
          return res.status(400).json({ error: "Template missing base PDF or schema" });
        }

        const { loadTemplate, generatePdf } = await import("../services/pdfGenerationService.js");
        const template = await loadTemplate(tmpl.base_pdf_key, tmpl.pdfme_schema);
        const fieldMappings = (tmpl.field_mappings ?? {}) as Record<string, string>;
        const pdfBuffer = await generatePdf(template, sample_data ?? {}, fieldMappings);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="preview-${tmpl.name}.pdf"`);
        res.send(pdfBuffer);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/workspace/templates/:id/annotated-pdf — PDF with field names filled in as labels
  router.get(
    "/templates/:id/annotated-pdf",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;

        const result = await db.execute(sql`
          SELECT * FROM workspace_templates WHERE id = ${req.params.id} AND company_id = ${companyId} LIMIT 1
        `);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0) return res.status(404).json({ error: "Template not found" });

        const tmpl = rows[0];
        if (!tmpl.base_pdf_key) return res.status(400).json({ error: "No base PDF" });

        const schema = tmpl.pdfme_schema;
        const isFormFill = schema?.mode === "form_fill";
        if (!isFormFill) return res.status(400).json({ error: "Not a form-fill template" });

        const { loadPdfBuffer } = await import("../services/pdfGenerationService.js");
        const { PDFDocument } = await import("pdf-lib");

        const pdfBuffer = await loadPdfBuffer(tmpl.base_pdf_key);
        const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
        const form = doc.getForm();
        const fieldMappings = (tmpl.field_mappings ?? {}) as Record<string, string>;

        // Snapshot fields array — we may remove fields during iteration
        const allFields = [...form.getFields()];

        // Fill each field with its name or mapped column for visual identification
        for (const field of allFields) {
          const name = field.getName();
          const constructor = field.constructor.name;
          const mapped = fieldMappings[name];
          const isStatic = mapped?.startsWith("__static:");
          const staticVal = isStatic ? mapped.replace("__static:", "") : "";

          // Build display label: mapped column, static value, or field name
          const label = isStatic
            ? staticVal
            : mapped
              ? `[${mapped}]`
              : `<${name}>`;

          try {
            if (constructor === "PDFTextField") {
              form.getTextField(name).setText(label);
            } else if (constructor === "PDFCheckBox") {
              if (isStatic && staticVal === "true") {
                form.getCheckBox(name).check();
              } else if (mapped && !isStatic) {
                form.getCheckBox(name).check(); // Show as checked when mapped to column
              }
            } else if (constructor === "PDFRadioGroup") {
              if (isStatic && staticVal) {
                try { form.getRadioGroup(name).select(staticVal); } catch { /* option may not exist */ }
              }
            } else if (constructor === "PDFSignature") {
              // Signature visualization is handled by the frontend overlay
              try { form.removeField(field); } catch { /* ignore */ }
              continue;
            } else if (constructor === "PDFDropdown") {
              // Can't set arbitrary text on dropdowns — leave as-is
            }
          } catch { /* skip fields that can't be filled */ }
        }

        const annotated = await doc.save();
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="annotated-${req.params.id}.pdf"`);
        res.send(Buffer.from(annotated));
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/workspace/templates/:id/pdf-page-info — page dimensions for each page of the PDF
  router.get(
    "/templates/:id/pdf-page-info",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const result = await db.execute(sql`
          SELECT * FROM workspace_templates WHERE id = ${req.params.id} AND company_id = ${companyId} LIMIT 1
        `);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0) return res.status(404).json({ error: "Template not found" });
        const tmpl = rows[0];
        if (!tmpl.base_pdf_key) return res.status(400).json({ error: "No base PDF" });

        const { loadPdfBuffer } = await import("../services/pdfGenerationService.js");
        const { PDFDocument } = await import("pdf-lib");
        const pdfBuffer = await loadPdfBuffer(tmpl.base_pdf_key);
        const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
        const pages = doc.getPages().map((p, i) => ({
          index: i,
          width: p.getWidth(),
          height: p.getHeight(),
        }));
        res.json({ pages });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/workspace/runs/:runId/files — list generated files for a run
  router.get(
    "/runs/:runId/files",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;

        const result = await db.execute(sql`
          SELECT generated_files FROM workspace_runs
          WHERE id = ${req.params.runId} AND company_id = ${companyId}
          LIMIT 1
        `);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0) return res.status(404).json({ error: "Run not found" });

        res.json({ files: rows[0].generated_files ?? [] });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/workspace/runs/:runId/file/:filename — serve a generated PDF from a run
  router.get(
    "/runs/:runId/file/:filename",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const runId = String(req.params.runId);
        const filename = String(req.params.filename);

        console.log(`[pdf-preview] runId=${runId} filename=${filename} companyId=${companyId}`);

        // Verify run belongs to this company
        const result = await db.execute(sql`
          SELECT id FROM workspace_runs
          WHERE id = ${runId} AND company_id = ${companyId}
          LIMIT 1
        `);
        const rows = ((result as any).rows ?? result) as any[];
        if (rows.length === 0) {
          console.log(`[pdf-preview] Run not found for runId=${runId} companyId=${companyId}`);
          return res.status(404).json({ error: "Run not found" });
        }

        // Sanitize filename — strip path traversal
        const pathMod = await import("path");
        const safeName = pathMod.basename(filename);
        const outDir = pathMod.resolve(process.cwd(), "uploads/runs", companyId, runId);
        const filePath = pathMod.resolve(outDir, safeName);
        console.log(`[pdf-preview] filePath=${filePath} exists=${(await import("fs")).existsSync(filePath)}`);
        if (!filePath.startsWith(outDir + pathMod.sep) && filePath !== outDir) {
          return res.status(400).json({ error: "Invalid filename" });
        }

        const { existsSync, readFileSync } = await import("fs");
        if (!existsSync(filePath)) {
          console.log(`[pdf-preview] File not found: ${filePath}`);
          return res.status(404).json({ error: "File not found", path: filePath });
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
        res.send(readFileSync(filePath));
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/workspace/templates/:id
  router.delete(
    "/templates/:id",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        await db.execute(sql`DELETE FROM workspace_templates WHERE id = ${req.params.id} AND company_id = ${companyId}`);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // Debug: test PDF fill with a specific run row to diagnose signature embedding (v4 - curl+altdns)
  router.get(
    "/debug/pdf-sig-test/:runId",
    authenticate(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const runId = String(req.params.runId);

        const runResult = await db.execute(sql`SELECT output_data FROM workspace_runs WHERE id = ${runId} AND company_id = ${companyId} LIMIT 1`);
        const runRows = ((runResult as any).rows ?? runResult) as any[];
        if (!runRows.length) { res.status(404).json({ error: "run not found" }); return; }

        const outputData = runRows[0].output_data as Record<string, unknown>[];
        const sigRow = outputData.find((r: any) => typeof r["payment.signature"] === "string" && r["payment.signature"].startsWith("http"));
        if (!sigRow) { res.json({ ok: false, error: "no row with payment.signature in this run" }); return; }

        const sigUrl = String(sigRow["payment.signature"]);
        const { fetchImageBuffer } = await import("../services/pdfGenerationService.js");
        const fetchResult = await fetchImageBuffer(sigUrl);
        const bodyBuf = fetchResult?.buf ?? null;
        const contentType = fetchResult?.mime ?? null;
        const fetchStatus = fetchResult ? 200 : 0;
        const fetchOk = !!fetchResult;

        const tmplResult = await db.execute(sql`SELECT base_pdf_key, field_mappings FROM workspace_templates WHERE id = '26237577-729b-4000-9810-7cbe77d7b048' AND company_id = ${companyId} LIMIT 1`);
        const tmplRows = ((tmplResult as any).rows ?? tmplResult) as any[];
        if (!tmplRows.length) { res.json({ ok: false, error: "template not found" }); return; }

        const { fillPdfForm, loadPdfBuffer } = await import("../services/pdfGenerationService.js");
        const pdfBuf = await loadPdfBuffer(tmplRows[0].base_pdf_key);
        const fieldMappings = tmplRows[0].field_mappings as Record<string, string>;
        const filledPdf = await fillPdfForm(pdfBuf, sigRow, fieldMappings);

        res.json({
          fetchStatus,
          fetchOk,
          contentType,
          imageSizeBytes: bodyBuf?.length ?? 0,
          fieldMappings,
          basePdfSize: pdfBuf.length,
          filledPdfSize: filledPdf.length,
          signatureEmbedded: filledPdf.length > pdfBuf.length + 5000,
          sigUrlStart: sigUrl.slice(0, 80),
        });
      } catch (err: any) {
        res.json({ error: String(err.message ?? err), stack: String(err.stack ?? "").slice(0, 500) });
      }
    },
  );

  return router;
}
