import { eq, and, lt, inArray } from "drizzle-orm";
import { agents, tasks, taskRuns } from "@agentops/db";
import { getDb } from "../lib/db.js";
import pino from "pino";

const logger = pino({ name: "heartbeat" });

const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes without heartbeat = degraded
const HEARTBEAT_DEAD_MS = 15 * 60 * 1000; // 15 minutes = error

let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Record a heartbeat for an agent, updating timestamps.
 */
export async function recordHeartbeat(agentId: string, companyId: string): Promise<void> {
  const db = getDb();
  const now = new Date();

  const [updated] = await db
    .update(agents)
    .set({ lastHeartbeatAt: now, updatedAt: now })
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .returning();

  if (!updated) {
    logger.warn({ agentId }, "Heartbeat for unknown agent");
    return;
  }

  // If agent was degraded, promote back to active
  if (updated.status === "degraded") {
    await db
      .update(agents)
      .set({ status: "active", updatedAt: now })
      .where(eq(agents.id, agentId));
    logger.info({ agentId }, "Agent recovered from degraded to active");
  }
}

/**
 * Record a heartbeat for a specific task run.
 */
export async function recordTaskRunHeartbeat(runId: string): Promise<void> {
  const db = getDb();
  await db
    .update(taskRuns)
    .set({ heartbeatAt: new Date() })
    .where(eq(taskRuns.id, runId));
}

/**
 * Check all active/testing agents for stale heartbeats.
 * - No heartbeat for 5 min → degraded
 * - No heartbeat for 15 min → error, fail running tasks
 */
export async function checkStaleAgents(): Promise<{
  degraded: string[];
  errored: string[];
}> {
  const db = getDb();
  const now = new Date();
  const degradedThreshold = new Date(now.getTime() - HEARTBEAT_TIMEOUT_MS);
  const errorThreshold = new Date(now.getTime() - HEARTBEAT_DEAD_MS);

  const degraded: string[] = [];
  const errored: string[] = [];

  // Get all active agents with stale heartbeats
  const activeAgents = await db.query.agents.findMany({
    where: inArray(agents.status, ["active", "testing", "degraded"]),
  });

  for (const agent of activeAgents) {
    if (!agent.lastHeartbeatAt) continue;

    const lastBeat = new Date(agent.lastHeartbeatAt);

    if (lastBeat < errorThreshold && agent.status !== "error") {
      // Dead agent — mark error, fail running tasks
      await db
        .update(agents)
        .set({ status: "error", updatedAt: now })
        .where(eq(agents.id, agent.id));

      // Fail running tasks assigned to this agent
      const runningTasks = await db.query.tasks.findMany({
        where: and(eq(tasks.agentId, agent.id), eq(tasks.status, "running")),
      });

      for (const task of runningTasks) {
        await db
          .update(tasks)
          .set({
            status: "failed",
            error: { code: "AGENT_TIMEOUT", message: `Agent ${agent.name} timed out` },
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(tasks.id, task.id));

        // Fail the active task run
        await db
          .update(taskRuns)
          .set({
            status: "timed_out",
            completedAt: now,
            error: { code: "AGENT_TIMEOUT", message: `Agent ${agent.name} timed out` },
          })
          .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.status, "running")));
      }

      errored.push(agent.id);
      logger.error(
        { agentId: agent.id, agentName: agent.name, staleSince: lastBeat.toISOString() },
        "Agent marked as error due to heartbeat timeout",
      );
    } else if (lastBeat < degradedThreshold && agent.status === "active") {
      // Stale agent — mark degraded
      await db
        .update(agents)
        .set({ status: "degraded", updatedAt: now })
        .where(eq(agents.id, agent.id));

      degraded.push(agent.id);
      logger.warn(
        { agentId: agent.id, agentName: agent.name, staleSince: lastBeat.toISOString() },
        "Agent marked as degraded",
      );
    }
  }

  return { degraded, errored };
}

/**
 * Start the periodic heartbeat checker.
 */
export function startHeartbeatChecker(intervalMs: number = 60_000): void {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(async () => {
    try {
      const result = await checkStaleAgents();
      if (result.degraded.length || result.errored.length) {
        logger.info(result, "Heartbeat check results");
      }
    } catch (err) {
      logger.error({ error: (err as Error).message }, "Heartbeat check failed");
    }
  }, intervalMs);
  logger.info({ intervalMs }, "Heartbeat checker started");
}

/**
 * Stop the periodic heartbeat checker.
 */
export function stopHeartbeatChecker(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
  }
}
