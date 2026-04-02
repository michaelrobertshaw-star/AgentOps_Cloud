/**
 * Tools Routes — CRUD + execution for platform tools
 *
 * Routes:
 *   GET    /api/tools            — List tools for company (optional ?connector_id filter)
 *   POST   /api/tools            — Create a tool
 *   GET    /api/tools/:id        — Get single tool
 *   PATCH  /api/tools/:id        — Update tool
 *   DELETE /api/tools/:id        — Delete tool
 *   POST   /api/tools/:id/test   — Execute tool with test data, save result
 *   POST   /api/tools/:id/execute — Execute tool with given input (used by agent worker)
 */

import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { tools, connectors } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError } from "../lib/errors.js";
import { executeTool } from "../services/toolExecutionService.js";

// ================================================================
// Validation schemas
// ================================================================

const createToolSchema = z.object({
  connectorId: z.string().uuid(),
  name: z.string().min(1).max(100),
  displayName: z.string().min(1).max(255),
  description: z.string().min(1),
  inputSchema: z.record(z.unknown()),
  httpMethod: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("POST"),
  endpointPath: z.string().min(1).max(500),
  fieldMapping: z.record(z.string()).optional().default({}),
  responseMapping: z.record(z.string()).optional().default({}),
  staticParams: z.record(z.unknown()).optional().default({}),
  testInput: z.record(z.unknown()).optional(),
  source: z.string().max(50).optional().default("manual"),
  enabled: z.boolean().optional().default(true),
});

const updateToolSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  displayName: z.string().min(1).max(255).optional(),
  description: z.string().min(1).optional(),
  inputSchema: z.record(z.unknown()).optional(),
  httpMethod: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  endpointPath: z.string().min(1).max(500).optional(),
  fieldMapping: z.record(z.string()).optional(),
  responseMapping: z.record(z.string()).optional(),
  staticParams: z.record(z.unknown()).optional(),
  testInput: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const executeToolSchema = z.object({
  input: z.record(z.unknown()),
  agentId: z.string().uuid().optional(),
  agentRunId: z.string().uuid().optional(),
});

// ================================================================
// Routes
// ================================================================

export function toolRoutes() {
  const router = Router();

  // GET /api/tools — list tools for company
  router.get(
    "/",
    authenticate(),
    requirePermission("connector:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const connectorId = req.query.connector_id as string | undefined;

        let where = eq(tools.companyId, companyId);
        if (connectorId) {
          where = and(
            eq(tools.companyId, companyId),
            eq(tools.connectorId, connectorId),
          )!;
        }

        const rows = await db
          .select()
          .from(tools)
          .where(where)
          .orderBy(tools.name);

        res.json(rows);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/tools — create a tool
  router.post(
    "/",
    authenticate(),
    requirePermission("connector:manage"),
    validate(createToolSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const body = req.body as z.infer<typeof createToolSchema>;

        // SECURITY: Verify connector belongs to the same company
        const connectorCheck = await db
          .select({ id: connectors.id })
          .from(connectors)
          .where(and(eq(connectors.id, body.connectorId), eq(connectors.companyId, req.companyId!)))
          .limit(1);
        if (connectorCheck.length === 0) {
          return res.status(403).json({ error: "Connector not found or does not belong to your company" });
        }

        const [tool] = await db
          .insert(tools)
          .values({
            companyId: req.companyId!,
            connectorId: body.connectorId,
            name: body.name,
            displayName: body.displayName,
            description: body.description,
            inputSchema: body.inputSchema,
            httpMethod: body.httpMethod,
            endpointPath: body.endpointPath,
            fieldMapping: body.fieldMapping,
            responseMapping: body.responseMapping,
            staticParams: body.staticParams,
            testInput: body.testInput || null,
            source: body.source,
            enabled: body.enabled,
          })
          .returning();

        res.status(201).json(tool);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/tools/:id — get single tool
  router.get(
    "/:id",
    authenticate(),
    requirePermission("connector:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const rows = await db
          .select()
          .from(tools)
          .where(
            and(eq(tools.id, (req.params.id as string)), eq(tools.companyId, req.companyId!)),
          )
          .limit(1);

        if (rows.length === 0) {
          throw new NotFoundError("Tool not found");
        }

        res.json(rows[0]);
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH /api/tools/:id — update tool
  router.patch(
    "/:id",
    authenticate(),
    requirePermission("connector:manage"),
    validate(updateToolSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const body = req.body as z.infer<typeof updateToolSchema>;

        const updated = await db
          .update(tools)
          .set({
            ...body,
            updatedAt: new Date(),
          })
          .where(
            and(eq(tools.id, (req.params.id as string)), eq(tools.companyId, req.companyId!)),
          )
          .returning();

        if (updated.length === 0) {
          throw new NotFoundError("Tool not found");
        }

        res.json(updated[0]);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/tools/:id — delete tool
  router.delete(
    "/:id",
    authenticate(),
    requirePermission("connector:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const deleted = await db
          .delete(tools)
          .where(
            and(eq(tools.id, (req.params.id as string)), eq(tools.companyId, req.companyId!)),
          )
          .returning();

        if (deleted.length === 0) {
          throw new NotFoundError("Tool not found");
        }

        res.json({ deleted: true, id: (req.params.id as string) });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/tools/:id/test — execute tool with test data
  router.post(
    "/:id/test",
    authenticate(),
    requirePermission("connector:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const toolId = (req.params.id as string);
        const companyId = req.companyId!;

        // Load tool to get test_input
        const toolRows = await db
          .select()
          .from(tools)
          .where(and(eq(tools.id, toolId), eq(tools.companyId, companyId)))
          .limit(1);

        if (toolRows.length === 0) {
          throw new NotFoundError("Tool not found");
        }

        const tool = toolRows[0];
        const testInput = (req.body?.input as Record<string, unknown>) ||
          (tool.testInput as Record<string, unknown>) ||
          {};

        const result = await executeTool(toolId as string, companyId, testInput);

        // Update last_test_at / last_test_ok on the tool
        await db
          .update(tools)
          .set({
            lastTestAt: new Date(),
            lastTestOk: result.success,
            updatedAt: new Date(),
          })
          .where(eq(tools.id, toolId));

        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/tools/auto-map — AI-powered field mapping
  // Takes: a sample API payload + a natural language description of what the tool does
  // Returns: generated input_schema + field_mapping
  router.post(
    "/auto-map",
    authenticate(),
    requirePermission("connector:manage"),
    async (req, res, next) => {
      try {
        const { samplePayload, sampleResponse, toolDescription, apiDocs, existingSchema, existingMapping } = req.body as {
          samplePayload: Record<string, unknown>;
          sampleResponse?: Record<string, unknown>;
          toolDescription?: string;
          apiDocs?: string;
          existingSchema?: Record<string, unknown>;
          existingMapping?: Record<string, string>;
        };

        if (!samplePayload || typeof samplePayload !== "object") {
          return res.status(400).json({ error: "samplePayload (JSON object) is required" });
        }

        // Flatten the sample payload to discover all fields with dot notation paths
        function flattenObj(obj: Record<string, unknown>, prefix = ""): Array<{ path: string; value: unknown; type: string }> {
          const results: Array<{ path: string; value: unknown; type: string }> = [];
          for (const [key, val] of Object.entries(obj)) {
            const fullPath = prefix ? `${prefix}.${key}` : key;
            if (val && typeof val === "object" && !Array.isArray(val)) {
              results.push(...flattenObj(val as Record<string, unknown>, fullPath));
            } else {
              results.push({ path: fullPath, value: val, type: Array.isArray(val) ? "array" : typeof val });
            }
          }
          return results;
        }

        const apiFields = flattenObj(samplePayload);
        const responseFields = sampleResponse ? flattenObj(sampleResponse) : [];

        // Build prompt for Claude to generate the mapping
        const apiFieldsList = apiFields
          .map((f) => `  ${f.path} (${f.type}) = ${JSON.stringify(f.value)}`)
          .join("\n");

        const responseFieldsList = responseFields.length > 0
          ? responseFields.map((f) => `  ${f.path} (${f.type}) = ${JSON.stringify(f.value)}`).join("\n")
          : "";

        const prompt = `You are a field mapping assistant. Given an API's expected JSON payload and a description of what the tool does, generate:

1. An "input_schema" — the fields an AI agent should collect from a user (friendly names, clear descriptions)
2. A "field_mapping" — how each input_schema field maps to the API's dot-notation path
${responseFieldsList ? '3. A "response_mapping" — maps API response fields to friendly names the agent can use when reporting results back to the user\n4. A "response_fields" — describes each meaningful response field' : ""}

Rules for INPUT mapping:
- Input field names should be snake_case and human-readable (e.g. "passenger_name" not "name")
- Every input field MUST map to exactly one API field path
- Mark truly required fields (without which the API call would fail)
- Skip internal/system fields the user wouldn't know (e.g. source_version, account_id, app_metadata IDs)
- Group related optional fields logically
- Descriptions should be short and tell the user what to provide
- For nested API fields, use dot notation in the mapping (e.g. "address.lat")
${responseFieldsList ? `
Rules for RESPONSE mapping:
- Map API response dot-notation paths to friendly snake_case names
- Only include fields meaningful to the user (skip version, code, internal IDs)
- Include fields the agent should report back (e.g. trip_id, status, driver name, ETA)
- response_fields should describe what each field means in plain language` : ""}

${toolDescription ? `Tool description: ${toolDescription}` : ""}
${apiDocs ? `\nAPI Documentation (use this to understand field constraints, which fields are updatable, and business rules):\n${apiDocs}` : ""}

API REQUEST payload fields:
${apiFieldsList}
${responseFieldsList ? `\nAPI RESPONSE fields:\n${responseFieldsList}` : ""}

${existingSchema ? `\nExisting input schema to refine:\n${JSON.stringify(existingSchema, null, 2)}` : ""}
${existingMapping ? `\nExisting mapping to refine:\n${JSON.stringify(existingMapping, null, 2)}` : ""}

Respond with ONLY valid JSON (no markdown, no backticks):
{
  "input_schema": {
    "type": "object",
    "required": ["field1", "field2"],
    "properties": {
      "field1": { "type": "string", "description": "..." },
      ...
    }
  },
  "field_mapping": {
    "field1": "api.path",
    ...
  },
  "confidence": [
    { "input": "field1", "api": "api.path", "score": 0.95, "reason": "exact semantic match" },
    ...
  ]${responseFieldsList ? `,
  "response_mapping": {
    "api.response.path": "friendly_name",
    ...
  },
  "response_fields": [
    { "apiField": "api.response.path", "friendlyName": "friendly_name", "description": "What this field means" },
    ...
  ]` : ""}
}`;

        // Call Claude to generate the mapping
        const { loadCompanyDefaultApiKey } = await import("./connectors.js");
        const apiKey = await loadCompanyDefaultApiKey(req.companyId!);
        if (!apiKey) {
          return res.status(400).json({ error: "No Anthropic API key configured. Add a claude_api connector." });
        }

        const llmRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 8192,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        if (!llmRes.ok) {
          const err = await llmRes.text();
          return res.status(500).json({ error: `LLM call failed: ${err.slice(0, 300)}` });
        }

        const llmBody = (await llmRes.json()) as { content: Array<{ text: string }> };
        let rawText = llmBody.content?.[0]?.text ?? "";

        // Strip markdown fences — handle any text before/after
        const jsonMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (jsonMatch) {
          rawText = jsonMatch[1].trim();
        } else {
          // Try to find the JSON object directly
          const firstBrace = rawText.indexOf("{");
          const lastBrace = rawText.lastIndexOf("}");
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            rawText = rawText.slice(firstBrace, lastBrace + 1);
          }
          rawText = rawText.trim();
        }

        let result;
        try {
          result = JSON.parse(rawText);
        } catch {
          return res.status(500).json({ error: "LLM returned invalid JSON", raw: rawText.slice(0, 500) });
        }

        res.json({
          apiFields: apiFields.map((f) => ({ path: f.path, type: f.type, sample: f.value })),
          inputSchema: result.input_schema,
          fieldMapping: result.field_mapping,
          confidence: result.confidence ?? [],
          responseMapping: result.response_mapping ?? {},
          responseFields: result.response_fields ?? [],
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/tools/:id/execute — execute tool with given input
  router.post(
    "/:id/execute",
    authenticate(),
    requirePermission("connector:manage"),
    validate(executeToolSchema),
    async (req, res, next) => {
      try {
        const { input, agentId, agentRunId } = req.body as z.infer<typeof executeToolSchema>;
        const result = await executeTool(
          (req.params.id as string) as string,
          req.companyId!,
          input,
          agentId,
          agentRunId,
        );
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
