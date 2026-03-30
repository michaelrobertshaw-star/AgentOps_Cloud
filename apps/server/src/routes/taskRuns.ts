import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { tasks, taskRuns, agents } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import {
  buildOutputKey,
  uploadTaskOutput,
  downloadTaskOutput,
  parseOutputRef,
} from "../services/storageService.js";

const completeRunSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled"]),
  output: z.record(z.unknown()).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export function taskRunRoutes() {
  const router = Router({ mergeParams: true });

  // GET /tasks/:taskId/runs — list runs for a task
  router.get("/", authenticate(), requirePermission("task:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const taskId = req.params.taskId as string;

      // Verify task belongs to company
      const task = await db.query.tasks.findFirst({
        where: and(eq(tasks.id, taskId), eq(tasks.companyId, req.companyId!)),
      });
      if (!task) {
        throw new NotFoundError("Task", taskId);
      }

      const runs = await db.query.taskRuns.findMany({
        where: eq(taskRuns.taskId, taskId),
      });

      res.json(runs);
    } catch (err) {
      next(err);
    }
  });

  // GET /tasks/:taskId/runs/:runId — get a specific run
  router.get("/:runId", authenticate(), requirePermission("task:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const taskId = req.params.taskId as string;
      const runId = req.params.runId as string;

      const task = await db.query.tasks.findFirst({
        where: and(eq(tasks.id, taskId), eq(tasks.companyId, req.companyId!)),
      });
      if (!task) {
        throw new NotFoundError("Task", taskId);
      }

      const run = await db.query.taskRuns.findFirst({
        where: and(eq(taskRuns.id, runId), eq(taskRuns.taskId, taskId)),
      });
      if (!run) {
        throw new NotFoundError("Task run", runId);
      }

      res.json(run);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /tasks/:taskId/runs/:runId/complete — complete a task run (agent reports back)
  router.patch(
    "/:runId/complete",
    authenticate(),
    requirePermission("task:create"),
    validate(completeRunSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const taskId = req.params.taskId as string;
        const runId = req.params.runId as string;

        const task = await db.query.tasks.findFirst({
          where: and(eq(tasks.id, taskId), eq(tasks.companyId, req.companyId!)),
        });
        if (!task) {
          throw new NotFoundError("Task", taskId);
        }

        const run = await db.query.taskRuns.findFirst({
          where: and(eq(taskRuns.id, runId), eq(taskRuns.taskId, taskId)),
        });
        if (!run) {
          throw new NotFoundError("Task run", runId);
        }
        if (run.status !== "running") {
          throw new ValidationError(`Run is already ${run.status}`);
        }

        const now = new Date();
        let outputRef: string | null = null;

        // If output is provided, upload to S3
        if (req.body.output && req.body.status === "completed") {
          const key = buildOutputKey(req.companyId!, taskId, run.runNumber, "output.json");
          outputRef = await uploadTaskOutput(key, JSON.stringify(req.body.output));
        }

        // Map run status from task status
        const runStatusMap: Record<string, string> = {
          completed: "completed",
          failed: "failed",
          cancelled: "cancelled",
        };

        // Update the run
        const [updatedRun] = await db
          .update(taskRuns)
          .set({
            status: runStatusMap[req.body.status] as "completed" | "failed" | "cancelled",
            completedAt: now,
            outputRef,
            error: req.body.error || null,
          })
          .where(eq(taskRuns.id, runId))
          .returning();

        // Update the parent task
        await db
          .update(tasks)
          .set({
            status: req.body.status,
            output: req.body.output || null,
            error: req.body.error || null,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(tasks.id, taskId));

        await req.audit?.({
          action: "task:run_complete",
          resourceType: "task_run",
          resourceId: updatedRun.id,
          departmentId: task.departmentId,
          changes: {
            before: { status: "running" },
            after: { status: req.body.status },
          },
        });

        res.json(updatedRun);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /tasks/:taskId/runs/:runId/output — download run output from S3
  router.get(
    "/:runId/output",
    authenticate(),
    requirePermission("task:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const taskId = req.params.taskId as string;
        const runId = req.params.runId as string;

        const task = await db.query.tasks.findFirst({
          where: and(eq(tasks.id, taskId), eq(tasks.companyId, req.companyId!)),
        });
        if (!task) {
          throw new NotFoundError("Task", taskId);
        }

        const run = await db.query.taskRuns.findFirst({
          where: and(eq(taskRuns.id, runId), eq(taskRuns.taskId, taskId)),
        });
        if (!run) {
          throw new NotFoundError("Task run", runId);
        }
        if (!run.outputRef) {
          throw new NotFoundError("Run output");
        }

        const { key } = parseOutputRef(run.outputRef);
        const { body, contentType } = await downloadTaskOutput(key);

        res.setHeader("Content-Type", contentType);
        res.send(body);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
