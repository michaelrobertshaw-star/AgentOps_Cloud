/**
 * M6.4 — Agent Execution Engine
 *
 * POST /api/agents/:agentId/run   — dispatch a task to an agent (calls Claude, streams output)
 * GET  /api/agents/:agentId/runs  — list runs for an agent
 * GET  /api/agent-runs/:runId     — get a specific agent run
 * GET  /api/agent-runs/:runId/stream — SSE endpoint for live output streaming
 *
 * Execution flow:
 *  1. Spend cap check (HTTP 402 if exceeded)
 *  2. Create agent_run record (status: running)
 *  3. Load skill instructions + connector secrets
 *  4. Select model (browser connector → ANTHROPIC_BROWSER_MODEL, else ANTHROPIC_DEFAULT_MODEL)
 *  5. Call Claude API with streaming
 *  6. Collect output chunks; stream via SSE to connected listeners
 *  7. On completion: store output, token counts, cost, duration
 */

import { Router } from "express";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import {
  agentRuns,
  agentSkills,
  skills,
  agents,
  connectors,
} from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, PaymentRequiredError } from "../lib/errors.js";
import { loadAgentConnectorSecrets, loadCompanyDefaultApiKey } from "./connectors.js";
import { checkSpendCap } from "./usage.js";
import { agentRunQueue } from "../queues/agentRunQueue.js";
import { sseListeners } from "../workers/agentRunWorker.js";

// SSE listeners and emitters are now in agentRunWorker.ts (imported above)

// ================================================================
// Build system prompt from agent identity + skills
// ================================================================

async function buildSystemPrompt(agentId: string, companyId: string): Promise<string> {
  const db = getDb();

  // Load agent for identity info
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
  });

  const assignments = await db.query.agentSkills.findMany({
    where: eq(agentSkills.agentId, agentId),
    with: { skill: true },
  });

  const parts: string[] = [];

  // Agent identity header — always present so the model knows who it is
  if (agent) {
    const identityLines = [`You are ${agent.name}, an AI agent on the AgentOps Cloud platform.`];
    if (agent.description) identityLines.push(agent.description);
    parts.push(identityLines.join("\n\n"));
  }

  // Skill content — support multiple key conventions; skip silently if content is null/empty
  for (const { skill } of assignments) {
    const content = skill.content as Record<string, unknown> | null;
    if (!content) continue;

    const text =
      (typeof content.instructions === "string" && content.instructions.trim()) ||
      (typeof content.system === "string" && content.system.trim()) ||
      (typeof content.markdown === "string" && content.markdown.trim()) ||
      (typeof content.text === "string" && content.text.trim()) ||
      null;

    if (text) {
      parts.push(`## Skill: ${skill.name}\n\n${text}`);
    }
  }

  return parts.length > 0
    ? parts.join("\n\n---\n\n")
    : "You are a helpful AI assistant. Complete the task provided by the user.";
}

// ================================================================
// Validation schemas
// ================================================================

const dispatchRunSchema = z.object({
  input: z.string().min(1, "input is required"),
  taskId: z.string().uuid().optional(),
  stream: z.boolean().optional().default(false),
});

// ================================================================
// Agent run routes: /api/agents/:agentId/runs
// ================================================================

export function agentRunRoutes() {
  const router = Router({ mergeParams: true });

  // POST /api/agents/:agentId/run — dispatch a task
  router.post(
    "/run",
    authenticate(),
    requirePermission("agent:view"),
    validate(dispatchRunSchema),
    async (req, res, next) => {
      const agentId = req.params.agentId as string;
      const companyId = req.companyId!;
      const db = getDb();

      try {
        // Verify agent belongs to this company
        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
        });
        if (!agent) throw new NotFoundError("Agent");

        // Spend cap enforcement (HTTP 402)
        const capCheck = await checkSpendCap(companyId);
        if (!capCheck.allowed) {
          throw new PaymentRequiredError(capCheck.reason ?? "Monthly spend cap exceeded");
        }

        // Determine provider, model, and credentials from connectors
        const connectorData = await loadAgentConnectorSecrets(agentId, companyId);
        const defaultModel = process.env.ANTHROPIC_DEFAULT_MODEL ?? "claude-sonnet-4-6";

        // Detect provider type from attached connectors
        let providerType: "anthropic" | "aws_bedrock" | "gcp_vertex" = "anthropic";
        let providerConfig: Record<string, string> = {};
        let model = defaultModel;
        let apiKey = "";

        // Check for Bedrock connector
        const bedrockConn = connectorData.find((c) => c.connector.type === "aws_bedrock");
        if (bedrockConn) {
          providerType = "aws_bedrock";
          const cfg = bedrockConn.connector.config as Record<string, string>;
          providerConfig = {
            access_key_id: bedrockConn.secrets.access_key_id ?? "",
            secret_access_key: bedrockConn.secrets.secret_access_key ?? "",
            region: cfg.region ?? "us-east-1",
          };
          model = cfg.model ?? "anthropic.claude-sonnet-4-6-v1:0";
        }

        // Check for Vertex connector (overrides Bedrock if both present)
        const vertexConn = connectorData.find((c) => c.connector.type === "gcp_vertex");
        if (vertexConn) {
          providerType = "gcp_vertex";
          const cfg = vertexConn.connector.config as Record<string, string>;
          providerConfig = {
            project_id: cfg.project_id ?? "",
            location: cfg.location ?? "us-central1",
            service_account_json: vertexConn.secrets.service_account_json ?? "",
          };
          model = cfg.model ?? "claude-sonnet-4-6@20250514";
        }

        // For Anthropic (default), find API key from connectors
        if (providerType === "anthropic") {
          for (const { connector, secrets } of connectorData) {
            if (
              (connector.type === "claude_api" || connector.type === "claude_browser") &&
              secrets.api_key
            ) {
              apiKey = secrets.api_key;
              break;
            }
          }
          if (!apiKey) {
            apiKey = await loadCompanyDefaultApiKey(companyId);
          }
          if (!apiKey) {
            apiKey = process.env.ANTHROPIC_API_KEY ?? "";
          }
        }

        // Create run record (status: running)
        const { input, taskId } = req.body as z.infer<typeof dispatchRunSchema>;

        const [run] = await db
          .insert(agentRuns)
          .values({
            companyId,
            agentId,
            taskId: taskId ?? null,
            status: "running",
            input: { text: input },
            model,
          })
          .returning();

        // Build system prompt from assigned skills
        const systemPrompt = await buildSystemPrompt(agentId, companyId);

        // Read RAG and routing config from agent.config
        const agentConfig = (agent.config as Record<string, unknown>) ?? {};
        const ragEnabled = agentConfig.rag_enabled === true;
        const ragPrompt = typeof agentConfig.rag_prompt === "string"
          ? agentConfig.rag_prompt : undefined;
        const ragTimeoutMs = typeof agentConfig.rag_timeout_ms === "number"
          ? agentConfig.rag_timeout_ms : undefined;
        const preferredModel = typeof agentConfig.preferred_model === "string"
          ? agentConfig.preferred_model : undefined;
        const routingPolicy = typeof agentConfig.routing_policy === "string"
          ? agentConfig.routing_policy : undefined;

        // If streaming requested, set up SSE headers immediately
        const wantStream = req.body.stream === true;
        if (wantStream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          res.flushHeaders();
          res.write(`data: {"runId":"${run.id}"}\n\n`);
        }

        // ── Dispatch to BullMQ persistent job queue ──────────────────
        await agentRunQueue.add(
          "run",
          {
            agentId,
            companyId,
            input,
            runId: run.id,
            model,
            systemPrompt,
            apiKey,
            ragEnabled,
            ragPrompt,
            ragTimeoutMs,
            preferredModel,
            routingPolicy,
            providerType,
            providerConfig,
          },
          {
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
          },
        );

        // For streaming: forward SSE chunks emitted by the worker
        if (wantStream) {
          if (!sseListeners.has(run.id)) {
            sseListeners.set(run.id, new Set());
          }
          const forwardListener = (chunk: string) => {
            if (chunk === "[DONE]") {
              res.write(`data: [DONE]\n\n`);
              res.end();
            } else {
              res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
            }
          };
          sseListeners.get(run.id)!.add(forwardListener);
          req.on("close", () => {
            sseListeners.get(run.id)?.delete(forwardListener);
          });
        }

        // If not streaming, wait for completion and return full result
        if (!wantStream) {
          // Return immediately with run id; caller polls GET /agent-runs/:runId
          res.status(202).json({ runId: run.id, status: "running" });
        }
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/agents/:agentId/runs — list runs for an agent
  router.get(
    "/runs",
    authenticate(),
    requirePermission("agent:view"),
    async (req, res, next) => {
      const agentId = req.params.agentId as string;
      const companyId = req.companyId!;
      const db = getDb();
      try {
        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
        });
        if (!agent) throw new NotFoundError("Agent");

        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const rows = await db.query.agentRuns.findMany({
          where: and(eq(agentRuns.agentId, agentId), eq(agentRuns.companyId, companyId)),
          orderBy: [desc(agentRuns.createdAt)],
          limit,
        });
        res.json(rows);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ================================================================
// Agent run detail routes: /api/agent-runs/:runId
// ================================================================

export function agentRunDetailRoutes() {
  const router = Router();

  // GET /api/agent-runs/:runId — get a specific run
  router.get("/:runId", authenticate(), requirePermission("agent:view"), async (req, res, next) => {
    const runId = req.params.runId as string;
    const companyId = req.companyId!;
    const db = getDb();
    try {
      const run = await db.query.agentRuns.findFirst({
        where: and(eq(agentRuns.id, runId), eq(agentRuns.companyId, companyId)),
      });
      if (!run) throw new NotFoundError("AgentRun");
      res.json(run);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/agent-runs/:runId/stream — SSE live output streaming
  router.get(
    "/:runId/stream",
    authenticate(),
    requirePermission("agent:view"),
    async (req, res, next) => {
      const runId = req.params.runId as string;
      const companyId = req.companyId!;
      const db = getDb();
      try {
        const run = await db.query.agentRuns.findFirst({
          where: and(eq(agentRuns.id, runId), eq(agentRuns.companyId, companyId)),
        });
        if (!run) throw new NotFoundError("AgentRun");

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        // If run is already completed, stream the full output and close
        if (run.status !== "running") {
          if (run.output) {
            res.write(`data: ${JSON.stringify({ chunk: run.output })}\n\n`);
          }
          if (run.error) {
            res.write(`data: ${JSON.stringify({ status: "failed", error: run.error })}\n\n`);
          }
          res.write(`data: [DONE]\n\n`);
          return res.end();
        }

        // Subscribe to live chunks
        if (!sseListeners.has(runId)) {
          sseListeners.set(runId, new Set());
        }
        const listener = (chunk: string) => {
          if (chunk === "[DONE]") {
            res.write(`data: [DONE]\n\n`);
            res.end();
          } else if (chunk.startsWith("{\"log\":") || chunk.startsWith("{\"ragStatus\":") || chunk.startsWith("{\"toolCall\":") || chunk.startsWith("{\"toolResult\":")) {
            // Structured event — send as-is so the UI can parse it separately
            res.write(`data: ${chunk}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
          }
        };
        sseListeners.get(runId)!.add(listener);

        // Heartbeat every 15s to keep connection alive
        const heartbeat = setInterval(() => {
          res.write(": heartbeat\n\n");
        }, 15_000);

        req.on("close", () => {
          clearInterval(heartbeat);
          sseListeners.get(runId)?.delete(listener);
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
