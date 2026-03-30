import { Queue, Worker, type Job } from "bullmq";
import { eq, and } from "drizzle-orm";
import { tasks, agents, taskRuns } from "@agentops/db";
import { getDb } from "../lib/db.js";
import { getEnv } from "../config/env.js";
import pino from "pino";

const logger = pino({ name: "scheduler" });

let taskQueue: Queue | undefined;
let taskWorker: Worker | undefined;

export interface TaskJobData {
  taskId: string;
  companyId: string;
  agentId: string;
}

function getRedisConnection() {
  const url = new URL(getEnv().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
  };
}

/**
 * Get or create the task queue instance.
 */
export function getTaskQueue(): Queue<TaskJobData> {
  if (!taskQueue) {
    taskQueue = new Queue<TaskJobData>("task-dispatch", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return taskQueue;
}

/**
 * Enqueue a task for dispatch to an agent.
 */
export async function enqueueTask(
  taskId: string,
  companyId: string,
  agentId: string,
  priority: string = "medium",
): Promise<string> {
  const queue = getTaskQueue();

  // Map priority to BullMQ priority (lower = higher priority)
  const priorityMap: Record<string, number> = {
    critical: 1,
    high: 2,
    medium: 3,
    low: 4,
  };

  const job = await queue.add(
    "dispatch",
    { taskId, companyId, agentId },
    { priority: priorityMap[priority] ?? 3 },
  );

  return job.id!;
}

/**
 * Process a dispatched task job.
 * Transitions the task from queued → running, creates a task run, and signals the agent.
 */
async function processTaskJob(job: Job<TaskJobData>): Promise<void> {
  const { taskId, companyId, agentId } = job.data;
  const db = getDb();

  logger.info({ taskId, agentId }, "Processing task dispatch");

  // Verify task is still in queued state
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)),
  });

  if (!task || task.status !== "queued") {
    logger.warn({ taskId, status: task?.status }, "Task no longer in queued state, skipping");
    return;
  }

  // Verify agent is available
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
  });

  if (!agent || !["active", "testing"].includes(agent.status)) {
    logger.warn({ agentId, status: agent?.status }, "Agent not available, requeueing");
    throw new Error(`Agent ${agentId} not available (status: ${agent?.status})`);
  }

  // Find the next run number
  const existingRuns = await db.query.taskRuns.findMany({
    where: eq(taskRuns.taskId, taskId),
  });
  const nextRunNumber = existingRuns.length + 1;

  // Create task run
  const [run] = await db
    .insert(taskRuns)
    .values({
      companyId,
      taskId,
      agentId,
      runNumber: nextRunNumber,
      status: "running",
      startedAt: new Date(),
    })
    .returning();

  // Transition task to running
  await db
    .update(tasks)
    .set({
      status: "running",
      agentId,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));

  logger.info({ taskId, agentId, runId: run.id, runNumber: nextRunNumber }, "Task dispatched to agent");
}

/**
 * Start the task worker that processes the queue.
 */
export function startTaskWorker(): Worker<TaskJobData> {
  if (taskWorker) return taskWorker;

  taskWorker = new Worker<TaskJobData>("task-dispatch", processTaskJob, {
    connection: getRedisConnection(),
    concurrency: 5,
  });

  taskWorker.on("completed", (job) => {
    logger.info({ jobId: job.id, taskId: job.data.taskId }, "Task dispatch completed");
  });

  taskWorker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, taskId: job?.data.taskId, error: error.message },
      "Task dispatch failed",
    );
  });

  return taskWorker;
}

/**
 * Gracefully shut down the queue and worker.
 */
export async function shutdownScheduler(): Promise<void> {
  if (taskWorker) {
    await taskWorker.close();
    taskWorker = undefined;
  }
  if (taskQueue) {
    await taskQueue.close();
    taskQueue = undefined;
  }
}
