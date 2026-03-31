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
import Anthropic from "@anthropic-ai/sdk";
import {
  agentRuns,
  agentSkills,
  skills,
  agents,
} from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, PaymentRequiredError } from "../lib/errors.js";
import { loadAgentConnectorSecrets } from "./connectors.js";
import { checkSpendCap } from "./usage.js";

// ================================================================
// In-memory SSE event bus (per run-id)
// ================================================================

type SseListener = (chunk: string) => void;

const sseListeners = new Map<string, Set<SseListener>>();

function emitChunk(runId: string, chunk: string) {
  const listeners = sseListeners.get(runId);
  if (listeners) {
    for (const fn of listeners) fn(chunk);
  }
}

function emitDone(runId: string) {
  const listeners = sseListeners.get(runId);
  if (listeners) {
    for (const fn of listeners) fn("[DONE]");
    sseListeners.delete(runId);
  }
}

// ================================================================
// Cost calculation (USD per token)
// Rates: claude-sonnet-4-6 = $3/M input, $15/M output
//        claude-3-5-sonnet-20241022 = $3/M input, $15/M output
// ================================================================

const MODEL_RATES: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
};

function calcCost(model: string, tokensIn: number, tokensOut: number): number {
  const rates = MODEL_RATES[model] ?? { inputPer1M: 3.0, outputPer1M: 15.0 };
  return (tokensIn / 1_000_000) * rates.inputPer1M + (tokensOut / 1_000_000) * rates.outputPer1M;
}

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

        // Determine model: use browser model if agent has a claude_browser connector
        const connectorData = await loadAgentConnectorSecrets(agentId, companyId);
        const hasBrowser = connectorData.some((c) => c.connector.type === "claude_browser");
        const defaultModel = process.env.ANTHROPIC_DEFAULT_MODEL ?? "claude-sonnet-4-6";
        const browserModel = process.env.ANTHROPIC_BROWSER_MODEL ?? "claude-3-5-sonnet-20241022";
        const model = hasBrowser ? browserModel : defaultModel;

        // Find API key from claude_api or claude_browser connector,
        // falling back to the env ANTHROPIC_API_KEY if none attached.
        let apiKey = process.env.ANTHROPIC_API_KEY ?? "";
        for (const { connector, secrets } of connectorData) {
          if (
            (connector.type === "claude_api" || connector.type === "claude_browser") &&
            secrets.api_key
          ) {
            apiKey = secrets.api_key;
            break;
          }
        }

        // Create run record (status: running)
        const { input, taskId } = req.body as z.infer<typeof dispatchRunSchema>;
        const startedAt = new Date();

        const [run] = await db
          .insert(agentRuns)
          .values({
            companyId,
            agentId,
            taskId: taskId ?? null,
            status: "running",
            input: { text: input },
            model,
            startedAt,
          })
          .returning();

        // Build system prompt from assigned skills
        const systemPrompt = await buildSystemPrompt(agentId, companyId);

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

        // ── Claude API call (async, non-blocking for SSE) ──────────────────
        const anthropic = new Anthropic({ apiKey });
        let fullOutput = "";
        let tokensInput = 0;
        let tokensOutput = 0;

        (async () => {
          try {
            const stream = await anthropic.messages.stream({
              model,
              max_tokens: 8096,
              system: systemPrompt,
              messages: [{ role: "user", content: input }],
            });

            for await (const event of stream) {
              if (
                event.type === "content_block_delta" &&
                event.delta.type === "text_delta"
              ) {
                const chunk = event.delta.text;
                fullOutput += chunk;
                if (wantStream) {
                  const encoded = JSON.stringify({ chunk });
                  res.write(`data: ${encoded}\n\n`);
                }
                emitChunk(run.id, chunk);
              }
            }

            // Final message with usage
            const finalMessage = await stream.finalMessage();
            tokensInput = finalMessage.usage?.input_tokens ?? 0;
            tokensOutput = finalMessage.usage?.output_tokens ?? 0;

            const completedAt = new Date();
            const durationMs = completedAt.getTime() - startedAt.getTime();
            const costUsd = calcCost(model, tokensInput, tokensOutput);

            await db
              .update(agentRuns)
              .set({
                status: "completed",
                output: fullOutput,
                tokensInput,
                tokensOutput,
                costUsd: String(costUsd),
                durationMs,
                completedAt,
              })
              .where(eq(agentRuns.id, run.id));

            if (wantStream) {
              res.write(`data: [DONE]\n\n`);
              res.end();
            }
            emitDone(run.id);
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            const completedAt = new Date();
            const durationMs = completedAt.getTime() - startedAt.getTime();

            await db
              .update(agentRuns)
              .set({
                status: "failed",
                error: errorMsg,
                durationMs,
                completedAt,
              })
              .where(eq(agentRuns.id, run.id));

            if (wantStream) {
              const errPayload = JSON.stringify({ error: errorMsg });
              res.write(`data: ${errPayload}\n\n`);
              res.end();
            }
            emitDone(run.id);
          }
        })();

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
            res.write(`data: ${JSON.stringify({ error: run.error })}\n\n`);
          }
          res.write(`data: [DONE]\n\n`);
          return res.end();
        }

        // Subscribe to live chunks
        if (!sseListeners.has(runId)) {
          sseListeners.set(runId, new Set());
        }
        const listener: SseListener = (chunk) => {
          if (chunk === "[DONE]") {
            res.write(`data: [DONE]\n\n`);
            res.end();
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
