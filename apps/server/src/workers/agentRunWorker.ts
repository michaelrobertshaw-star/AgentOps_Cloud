import { Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { agentRuns } from "@agentops/db";
import { getDb } from "../lib/db.js";
import { getRedisConnection } from "../lib/redis.js";
import type { AgentRunJobData } from "../queues/agentRunQueue.js";
import { retrieveContext } from "../services/ragService.js";
import { createAdapter, calcCost, getModelMaxTokens } from "../services/modelAdapters.js";
import type { ProviderConfig } from "../services/modelAdapters.js";
import { parseMcpConfig, callMcpTool } from "../services/mcpService.js";
import type { McpServerConfig } from "../services/mcpService.js";
import { executeTool } from "../services/toolExecutionService.js";

// In-memory SSE event bus (shared with agentRuns route via module-level singleton)
type SseListener = (chunk: string) => void;
export const sseListeners = new Map<string, Set<SseListener>>();

export function emitChunk(runId: string, chunk: string) {
  const listeners = sseListeners.get(runId);
  if (listeners) {
    for (const fn of listeners) fn(chunk);
  }
}

export function emitDone(runId: string) {
  const listeners = sseListeners.get(runId);
  if (listeners) {
    for (const fn of listeners) fn("[DONE]");
    sseListeners.delete(runId);
  }
}

// ── Structured run log ──────────────────────────────────────────
interface RunLogEntry {
  ts: string;       // ISO timestamp
  stage: string;    // e.g. "init", "rag", "model", "mcp", "done"
  message: string;  // human-readable
  detail?: Record<string, unknown>; // optional structured data
  level: "info" | "warn" | "error";
  durationMs?: number;
}

function emitLog(
  runId: string,
  logs: RunLogEntry[],
  stage: string,
  message: string,
  detail?: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
  durationMs?: number,
) {
  const entry: RunLogEntry = {
    ts: new Date().toISOString(),
    stage,
    message,
    level,
    ...(detail ? { detail } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
  logs.push(entry);
  emitChunk(runId, JSON.stringify({ log: entry }));
  console.log(`[agentRunWorker] [${stage}] ${message}`);
}

export const agentRunWorker = new Worker<AgentRunJobData>(
  "agent-runs",
  async (job) => {
    const { input, runId, model, systemPrompt, apiKey, agentId, companyId } = job.data;
    const db = getDb();
    const startedAt = new Date();
    const logs: RunLogEntry[] = [];

    emitLog(runId, logs, "init", `Run started for agent ${agentId.slice(0, 8)}`, {
      runId,
      agentId,
      inputLength: input.length,
      inputPreview: input.slice(0, 120) + (input.length > 120 ? "..." : ""),
    });

    // ── Model selection with routing policy ────────────────────
    let selectedModel = model;
    let modelReason = "default";
    if (job.data.preferredModel) {
      selectedModel = job.data.preferredModel;
      modelReason = "preferred_model override";
    } else if (job.data.routingPolicy === "cost_sensitive") {
      selectedModel = "claude-haiku-4-5-20251001";
      modelReason = "routing policy: cost_sensitive";
    } else if (job.data.routingPolicy === "accuracy_first") {
      selectedModel = "claude-sonnet-4-6";
      modelReason = "routing policy: accuracy_first";
    } else if (job.data.routingPolicy === "speed_optimized") {
      selectedModel = "claude-haiku-4-5-20251001";
      modelReason = "routing policy: speed_optimized";
    }

    emitLog(runId, logs, "model", `Selected model: ${selectedModel}`, {
      model: selectedModel,
      reason: modelReason,
      routingPolicy: job.data.routingPolicy ?? "none",
      maxTokens: getModelMaxTokens(selectedModel),
    });

    // ── RAG context injection ──────────────────────────────────
    let enrichedSystemPrompt = systemPrompt;
    let ragChunks: string[] | null = null;

    if (job.data.ragEnabled) {
      const ragTimeoutMs = job.data.ragTimeoutMs ?? 2000;
      const ragStartMs = Date.now();
      emitLog(runId, logs, "rag", `RAG retrieval started (timeout: ${ragTimeoutMs}ms)`, {
        ragEnabled: true,
        ragTimeoutMs,
      });

      try {
        const ragPromise = retrieveContext(agentId, companyId, input, 3);
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), ragTimeoutMs),
        );

        const result = await Promise.race([
          ragPromise.then((chunks) => ({ type: "chunks" as const, chunks })),
          timeoutPromise.then(() => ({ type: "timeout" as const, chunks: null as string[] | null })),
        ]);

        const ragDurationMs = Date.now() - ragStartMs;

        if (result.type === "chunks" && result.chunks && result.chunks.length > 0) {
          ragChunks = result.chunks;
          const contextChars = ragChunks.reduce((s, c) => s + c.length, 0);
          const defaultRagPrompt = "Answer ONLY based on the knowledge provided below. Do not add information, policies, procedures, or details that are not explicitly stated in this context. If the answer is not covered by the provided knowledge, say you don't have that information. Never fabricate or assume details beyond what is written here.";
          const ragInstruction = job.data.ragPrompt || defaultRagPrompt;
          enrichedSystemPrompt = systemPrompt +
            "\n\n---\n\n## Relevant Knowledge\n\nIMPORTANT: " + ragInstruction + "\n\n" +
            ragChunks.join("\n\n---\n\n");
          emitLog(runId, logs, "rag", `Injected ${ragChunks.length} knowledge chunks (${contextChars} chars)`, {
            chunks: ragChunks.length,
            totalChars: contextChars,
            chunkPreviews: ragChunks.map((c) => c.slice(0, 80) + "..."),
          }, "info", ragDurationMs);
          emitChunk(runId, JSON.stringify({ ragStatus: "loaded", chunks: ragChunks.length }));
        } else if (result.type === "chunks" && (!result.chunks || result.chunks.length === 0)) {
          emitLog(runId, logs, "rag", "No relevant knowledge found in database", {
            chunks: 0,
          }, "warn", ragDurationMs);
          emitChunk(runId, JSON.stringify({ ragStatus: "loaded", chunks: 0 }));
        } else {
          emitLog(runId, logs, "rag", `RAG retrieval timed out after ${ragTimeoutMs}ms — proceeding without knowledge`, {
            timeoutMs: ragTimeoutMs,
          }, "warn", ragDurationMs);
          emitChunk(runId, JSON.stringify({ ragStatus: "timeout" }));

          ragPromise
            .then((chunks) => {
              if (chunks.length > 0) {
                console.log(`[agentRunWorker] RAG: late retrieval completed with ${chunks.length} chunks for run ${runId} (not injected)`);
              }
            })
            .catch((err) => {
              console.error(`[agentRunWorker] RAG: background retrieval failed for run ${runId}:`, err);
            });
        }
      } catch (err) {
        const ragDurationMs = Date.now() - ragStartMs;
        emitLog(runId, logs, "rag", `RAG retrieval failed: ${err instanceof Error ? err.message : String(err)}`, {
          error: String(err),
        }, "error", ragDurationMs);
      }
    } else {
      emitLog(runId, logs, "rag", "RAG disabled for this agent", { ragEnabled: false });
    }

    // ── Shared memory injection ──────────────────────────────────
    try {
      const db = (await import("../lib/db.js")).getDb();
      const { sql } = await import("drizzle-orm");
      const memResult = await db.execute(sql`
        SELECT category, title, content, upvotes
        FROM agent_memories
        WHERE company_id = ${companyId}
        ORDER BY upvotes DESC, created_at DESC
        LIMIT 20
      `);
      const memRows = (memResult as unknown as { rows: Array<{ category: string; title: string; content: string; upvotes: number }> }).rows ?? memResult;
      if (Array.isArray(memRows) && memRows.length > 0) {
        let memoryBlock = "\n\n## Shared Agent Memory\nLearnings from all agents in this organization:\n";
        for (const m of memRows) {
          const votes = m.upvotes > 0 ? ` (${m.upvotes} upvotes)` : "";
          memoryBlock += `\n**${m.title}**${votes}: ${m.content}\n`;
        }
        enrichedSystemPrompt += memoryBlock;
        emitLog(runId, logs, "memory", `Injected ${memRows.length} shared memories`, { count: memRows.length });
      }
    } catch (err) {
      emitLog(runId, logs, "memory", `Failed to load memories: ${err instanceof Error ? err.message : String(err)}`, {}, "warn");
    }

    // ── Auto-learning instruction (save_memory tool) ──────────
    enrichedSystemPrompt += `\n\n## Automatic Learning (save_memory tool)
You have a tool called "save_memory" that saves learnings to the organization's shared brain.
USE IT ONLY when you discover something genuinely valuable:
- You resolved a tool error (save the fix so other agents don't hit the same issue)
- You discovered an API quirk or undocumented behavior
- You found a better way to map fields or structure requests
- You learned something about data formats the API expects

DO NOT save memories for:
- Routine successful operations (e.g. "booking created successfully")
- Information the user already told you
- Generic knowledge that isn't specific to this organization's setup
- Anything already in the Shared Agent Memory above

Before saving, mentally check: "Would another agent benefit from knowing this?" If no, don't save.
Keep memories concise — title should be scannable, content should be actionable.`;

    // ── Provider config ────────────────────────────────────────
    const providerType = job.data.providerType ?? "anthropic";
    const pc = job.data.providerConfig ?? {};

    const providerConfig: ProviderConfig = {
      type: providerType,
      apiKey,
      awsAccessKeyId: pc.access_key_id,
      awsSecretAccessKey: pc.secret_access_key,
      awsRegion: pc.region,
      gcpProjectId: pc.project_id,
      gcpLocation: pc.location,
      gcpServiceAccountJson: pc.service_account_json,
    };

    const adapter = createAdapter(providerConfig);
    const maxTokens = getModelMaxTokens(selectedModel);

    emitLog(runId, logs, "provider", `Using provider: ${providerType}`, {
      provider: providerType,
      hasApiKey: !!apiKey,
    });

    // ── Load MCP server tools ──────────────────────────────────
    const mcpConfigs: Array<{ name: string; config: McpServerConfig }> = [];
    let allTools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> = [];
    try {
      const attachedConnectors = await db.execute(sql`
        SELECT c.name, c.config, c.type
        FROM agent_connectors ac
        JOIN connectors c ON c.id = ac.connector_id
        WHERE ac.agent_id = ${agentId}
          AND ac.company_id = ${companyId}
          AND c.type = 'mcp_server'
      `);
      const mcpRows = (Array.isArray(attachedConnectors) ? attachedConnectors : (attachedConnectors as any).rows ?? []) as Array<{ name: string; config: Record<string, unknown>; type: string }>;

      for (const row of mcpRows) {
        const cfg = parseMcpConfig(row.config as Record<string, unknown>);
        mcpConfigs.push({ name: row.name, config: cfg });
        allTools.push(...cfg.tools);
      }
      if (allTools.length > 0) {
        emitLog(runId, logs, "mcp", `Loaded ${allTools.length} tools from ${mcpConfigs.length} MCP servers`, {
          servers: mcpConfigs.map((m) => m.name),
          tools: allTools.map((t) => t.name),
        });
      } else {
        emitLog(runId, logs, "mcp", "No MCP tools attached to this agent");
      }
    } catch (err) {
      emitLog(runId, logs, "mcp", `Failed to load MCP tools: ${err instanceof Error ? err.message : String(err)}`, {}, "warn");
    }

    // ── Load platform tools (from tools table) ─────────────────
    interface PlatformToolDef {
      id: string;
      name: string;
      displayName: string;
      description: string;
      inputSchema: Record<string, unknown>;
      httpMethod: string;
      endpointPath: string;
      fieldMapping: Record<string, unknown>;
      connectorId: string;
    }
    let platformTools: PlatformToolDef[] = [];
    try {
      const ptResult = await db.execute(sql`
        SELECT t.id, t.name, t.display_name, t.description, t.input_schema,
               t.http_method, t.endpoint_path, t.field_mapping, t.connector_id
        FROM tools t
        JOIN connectors c ON c.id = t.connector_id
        JOIN agent_connectors ac ON ac.connector_id = c.id
        WHERE ac.agent_id = ${agentId}
          AND ac.company_id = ${companyId}
          AND t.enabled = true
      `);
      const ptRows = (Array.isArray(ptResult) ? ptResult : (ptResult as any).rows ?? []) as PlatformToolDef[];
      platformTools = ptRows.map((row) => ({
        id: row.id,
        name: row.name,
        displayName: row.displayName ?? (row as any).display_name,
        description: row.description,
        inputSchema: (row.inputSchema ?? (row as any).input_schema) as Record<string, unknown>,
        httpMethod: (row.httpMethod ?? (row as any).http_method) as string,
        endpointPath: (row.endpointPath ?? (row as any).endpoint_path) as string,
        fieldMapping: (row.fieldMapping ?? (row as any).field_mapping) as Record<string, unknown>,
        connectorId: (row.connectorId ?? (row as any).connector_id) as string,
      }));

      if (platformTools.length > 0) {
        // Add platform tools to the allTools array for the LLM
        for (const pt of platformTools) {
          allTools.push({
            name: pt.name,
            description: pt.description,
            input_schema: pt.inputSchema,
          });
        }
        emitLog(runId, logs, "tools", `Loaded ${platformTools.length} platform tools`, {
          tools: platformTools.map((t) => t.name),
        });
      }
      // Inject error self-resolution knowledge when tools are present
      if (allTools.length > 0) {
        enrichedSystemPrompt += `\n\n## Tool Error Self-Resolution
When a tool call returns an error, follow these steps BEFORE reporting failure:
1. **Auth errors (401, "Missing Authorization")**: Tell the user to check API credentials in Admin > Connectors.
2. **501/500 errors**: Check if you sent the correct field types (numbers not strings, valid ISO dates). If a path parameter like {trip_id} was needed, verify you provided the correct ID. Retry once.
3. **"App Key Not Configured"**: The API key needs activation — this is an admin issue, not a data issue.
4. **Field validation errors**: Review which fields are required vs optional. Re-read the tool description for format hints (E.164 phone, ISO 8601 dates, numeric IDs).
5. **Never invent workarounds or fake success**. Report the exact error code and message, then suggest the specific fix.
6. **For path parameters**: Use the exact value from previous tool responses. Trip IDs are numeric only — no letters or suffixes.`;
      }
    } catch (err) {
      emitLog(runId, logs, "tools", `Failed to load platform tools: ${err instanceof Error ? err.message : String(err)}`, {}, "warn");
    }

    // ── Built-in save_memory tool ────────────────────────────────
    allTools.push({
      name: "save_memory",
      description: "Save a valuable learning to the organization's shared brain. Only use when you discover something genuinely useful — error fixes, API quirks, field mapping insights, undocumented behaviors. Do NOT save routine successes or obvious information.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Short scannable title — e.g. 'iCabbi requires E.164 phone format'" },
          content: { type: "string", description: "Actionable description of the learning. Be specific and concise." },
          category: {
            type: "string",
            enum: ["error_fix", "api_quirk", "tool_tip", "prompt_pattern", "learning"],
            description: "Category: error_fix (resolved an error), api_quirk (undocumented behavior), tool_tip (better way to use a tool), prompt_pattern (effective prompt technique), learning (general insight)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for searchability — e.g. ['icabbi', 'booking', 'auth']",
          },
        },
        required: ["title", "content", "category"],
      },
    });

    // ── LLM execution ──────────────────────────────────────────
    try {
      const MAX_TOOL_ITERATIONS = 10;
      let messages: Array<{ role: "user" | "assistant"; content: string | Array<unknown> }> = [];
      let iteration = 0;
      let totalTokensIn = 0;
      let totalTokensOut = 0;
      let fullOutput = "";

      const llmStartMs = Date.now();
      emitLog(runId, logs, "llm", `Calling ${selectedModel} (max ${maxTokens} tokens)...`, {
        systemPromptLength: enrichedSystemPrompt.length,
        hasRagContext: !!ragChunks,
        hasTools: allTools.length > 0,
      });

      // First call
      let result = await adapter.stream(
        {
          model: selectedModel,
          systemPrompt: enrichedSystemPrompt,
          userInput: input,
          maxTokens,
          tools: allTools.length > 0 ? allTools : undefined,
        },
        (chunk) => {
          if (chunk.type === "text") emitChunk(runId, chunk.text);
          else if (chunk.type === "tool_use") {
            emitChunk(runId, JSON.stringify({ toolCall: { name: chunk.name, input: chunk.input } }));
          }
        },
      );

      const firstCallMs = Date.now() - llmStartMs;
      totalTokensIn += result.tokensInput;
      totalTokensOut += result.tokensOutput;
      fullOutput += result.output;

      emitLog(runId, logs, "llm", `First LLM call completed (${result.tokensInput} in / ${result.tokensOutput} out)`, {
        tokensIn: result.tokensInput,
        tokensOut: result.tokensOutput,
        stopReason: result.stopReason,
        outputLength: result.output.length,
      }, "info", firstCallMs);

      // Tool use loop
      while (
        result.stopReason === "tool_use" &&
        result.toolCalls &&
        result.toolCalls.length > 0 &&
        iteration < MAX_TOOL_ITERATIONS
      ) {
        iteration++;
        emitLog(runId, logs, "mcp", `Tool iteration ${iteration}: executing ${result.toolCalls.map((tc) => tc.name).join(", ")}`, {
          iteration,
          tools: result.toolCalls.map((tc) => tc.name),
        });

        const assistantContent: Array<unknown> = [];
        if (result.output) {
          assistantContent.push({ type: "text", text: result.output });
        }
        for (const tc of result.toolCalls) {
          assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }

        const toolResults: Array<unknown> = [];
        for (const tc of result.toolCalls) {
          const toolStartMs = Date.now();
          let toolResult: { content: string; isError?: boolean } = { content: `Tool "${tc.name}" not found`, isError: true };

          // Check built-in save_memory tool first
          if (tc.name === "save_memory") {
            try {
              const memInput = tc.input as { title: string; content: string; category: string; tags?: string[] };
              const memDb = (await import("../lib/db.js")).getDb();
              const { sql: memSql } = await import("drizzle-orm");

              // Deduplication: check if a memory with very similar title already exists
              const existing = await memDb.execute(memSql`
                SELECT id FROM agent_memories
                WHERE company_id = ${companyId}
                  AND LOWER(title) = LOWER(${memInput.title})
                LIMIT 1
              `);
              const existingRows = (existing as unknown as { rows: unknown[] }).rows ?? existing;
              if (Array.isArray(existingRows) && existingRows.length > 0) {
                toolResult = { content: JSON.stringify({ saved: false, reason: "A memory with this title already exists. Skip duplicates." }) };
              } else {
                await memDb.execute(memSql`
                  INSERT INTO agent_memories (company_id, agent_id, category, title, content, source, tags)
                  VALUES (${companyId}, ${agentId}, ${memInput.category}, ${memInput.title}, ${memInput.content}, ${"agent_auto"}, ${memInput.tags ?? []})
                `);
                toolResult = { content: JSON.stringify({ saved: true, title: memInput.title }) };
                emitLog(runId, logs, "memory", `Agent saved memory: "${memInput.title}"`, { category: memInput.category });
              }
            } catch (memErr) {
              toolResult = { content: `Failed to save memory: ${memErr instanceof Error ? memErr.message : String(memErr)}`, isError: true };
            }
          }
          // Check platform tools
          else {
            const platformTool = platformTools.find((pt) => pt.name === tc.name);
            if (platformTool) {
              try {
                const execResult = await executeTool(platformTool.id, companyId, tc.input as Record<string, unknown>, agentId, runId);
                toolResult = { content: JSON.stringify(execResult.response), isError: !execResult.success };
              } catch (err) {
                toolResult = { content: `Platform tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
              }
            } else {
              // Fall back to MCP tools
              for (const mcp of mcpConfigs) {
                if (mcp.config.tools.some((t) => t.name === tc.name)) {
                  toolResult = await callMcpTool(mcp.config, tc.name, tc.input);
                  break;
                }
              }
            }
          }
          const toolDurationMs = Date.now() - toolStartMs;

          emitLog(runId, logs, "mcp", `Tool "${tc.name}" returned (${toolResult.content.length} chars)`, {
            tool: tc.name,
            resultLength: toolResult.content.length,
            isError: toolResult.isError ?? false,
            resultPreview: toolResult.content.slice(0, 200),
          }, toolResult.isError ? "warn" : "info", toolDurationMs);

          emitChunk(runId, JSON.stringify({ toolResult: { name: tc.name, result: toolResult.content } }));
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: toolResult.content,
            is_error: toolResult.isError ?? false,
          });
        }

        if (messages.length === 0) {
          messages = [{ role: "user", content: input }];
        }
        messages.push({ role: "assistant", content: assistantContent as any });
        messages.push({ role: "user", content: toolResults as any });

        fullOutput = "";
        const iterStartMs = Date.now();
        result = await adapter.stream(
          {
            model: selectedModel,
            systemPrompt: enrichedSystemPrompt,
            userInput: "",
            maxTokens,
            tools: allTools,
            messages,
          },
          (chunk) => {
            if (chunk.type === "text") emitChunk(runId, chunk.text);
          },
        );
        const iterDurationMs = Date.now() - iterStartMs;

        totalTokensIn += result.tokensInput;
        totalTokensOut += result.tokensOutput;
        fullOutput += result.output;

        emitLog(runId, logs, "llm", `Continuation call ${iteration} completed (${result.tokensInput} in / ${result.tokensOutput} out)`, {
          iteration,
          tokensIn: result.tokensInput,
          tokensOut: result.tokensOutput,
          stopReason: result.stopReason,
        }, "info", iterDurationMs);
      }

      // ── Completion ─────────────────────────────────────────────
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const costUsd = calcCost(selectedModel, totalTokensIn, totalTokensOut);

      emitLog(runId, logs, "done", `Run completed in ${(durationMs / 1000).toFixed(1)}s — ${totalTokensIn + totalTokensOut} total tokens, $${costUsd.toFixed(4)}`, {
        durationMs,
        totalTokensIn,
        totalTokensOut,
        costUsd,
        model: selectedModel,
        toolIterations: iteration,
        ragChunksUsed: ragChunks?.length ?? 0,
        outputLength: fullOutput.length,
      }, "info", durationMs);

      await db
        .update(agentRuns)
        .set({
          status: "completed",
          output: fullOutput,
          model: selectedModel,
          tokensInput: totalTokensIn,
          tokensOutput: totalTokensOut,
          costUsd: String(costUsd),
          durationMs,
          completedAt,
          logs: logs as any,
        })
        .where(eq(agentRuns.id, runId));

      emitDone(runId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();

      emitLog(runId, logs, "error", `Run failed after ${(durationMs / 1000).toFixed(1)}s: ${errorMsg}`, {
        error: errorMsg,
        durationMs,
      }, "error", durationMs);

      await db
        .update(agentRuns)
        .set({
          status: "failed",
          error: errorMsg,
          durationMs,
          completedAt,
          logs: logs as any,
        })
        .where(eq(agentRuns.id, runId));

      emitDone(runId);
      throw err;
    }
  },
  {
    connection: getRedisConnection(),
    concurrency: 5,
  },
);

agentRunWorker.on("failed", (job, err) => {
  if (job) {
    console.error(`[agentRunWorker] Job ${job.id} failed after ${job.attemptsMade} attempts:`, err.message);
  }
});
