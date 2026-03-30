import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { tasks, departments, agents } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import type { TaskStatus } from "@agentops/shared";

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  departmentId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  parentTaskId: z.string().uuid().optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  input: z.record(z.unknown()).optional(),
  maxRetries: z.number().int().min(0).max(10).default(3),
  timeoutSeconds: z.number().int().min(30).max(86400).default(1800),
  scheduledAt: z.string().datetime().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  status: z
    .enum(["pending", "queued", "running", "completed", "failed", "retrying", "escalated", "cancelled"])
    .optional(),
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).nullable().optional(),
  error: z.record(z.unknown()).nullable().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  timeoutSeconds: z.number().int().min(30).max(86400).optional(),
});

// Valid task status transitions
const VALID_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [], // terminal
  failed: ["retrying", "pending", "cancelled"],
  retrying: ["queued", "failed", "cancelled"],
  escalated: ["pending", "cancelled"],
  cancelled: [], // terminal
};

function validateTaskTransition(current: TaskStatus, next: TaskStatus): void {
  if (current === next) return;
  const allowed = VALID_TASK_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new ValidationError(
      `Invalid task status transition from '${current}' to '${next}'. Allowed: ${allowed.join(", ") || "none (terminal state)"}`,
    );
  }
}

export function taskRoutes() {
  const router = Router();

  // GET /tasks — list tasks for the company
  router.get("/", authenticate(), requirePermission("task:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const allTasks = await db.query.tasks.findMany({
        where: eq(tasks.companyId, req.companyId!),
      });

      let result = allTasks;
      if (req.query.departmentId) {
        result = result.filter((t) => t.departmentId === req.query.departmentId);
      }
      if (req.query.agentId) {
        result = result.filter((t) => t.agentId === req.query.agentId);
      }
      if (req.query.status) {
        result = result.filter((t) => t.status === req.query.status);
      }
      if (req.query.priority) {
        result = result.filter((t) => t.priority === req.query.priority);
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /tasks — create a new task
  router.post(
    "/",
    authenticate(),
    requirePermission("task:create"),
    validate(createTaskSchema),
    async (req, res, next) => {
      try {
        const db = getDb();

        // Validate department exists
        const dept = await db.query.departments.findFirst({
          where: and(
            eq(departments.id, req.body.departmentId),
            eq(departments.companyId, req.companyId!),
          ),
        });
        if (!dept) {
          throw new NotFoundError("Department", req.body.departmentId);
        }

        // Validate agent if provided
        if (req.body.agentId) {
          const agent = await db.query.agents.findFirst({
            where: and(
              eq(agents.id, req.body.agentId),
              eq(agents.companyId, req.companyId!),
            ),
          });
          if (!agent) {
            throw new NotFoundError("Agent", req.body.agentId);
          }
        }

        // Validate parent task if provided
        if (req.body.parentTaskId) {
          const parent = await db.query.tasks.findFirst({
            where: and(
              eq(tasks.id, req.body.parentTaskId),
              eq(tasks.companyId, req.companyId!),
            ),
          });
          if (!parent) {
            throw new NotFoundError("Parent task", req.body.parentTaskId);
          }
        }

        const [task] = await db
          .insert(tasks)
          .values({
            companyId: req.companyId!,
            departmentId: req.body.departmentId,
            agentId: req.body.agentId,
            parentTaskId: req.body.parentTaskId,
            title: req.body.title,
            description: req.body.description,
            priority: req.body.priority,
            input: req.body.input,
            maxRetries: req.body.maxRetries,
            timeoutSeconds: req.body.timeoutSeconds,
            scheduledAt: req.body.scheduledAt ? new Date(req.body.scheduledAt) : undefined,
          })
          .returning();

        await req.audit?.({
          action: "task:create",
          resourceType: "task",
          resourceId: task.id,
          departmentId: task.departmentId,
        });

        res.status(201).json(task);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /tasks/:id — get a single task
  router.get("/:id", authenticate(), requirePermission("task:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const id = req.params.id as string;
      const task = await db.query.tasks.findFirst({
        where: and(eq(tasks.id, id), eq(tasks.companyId, req.companyId!)),
      });
      if (!task) {
        throw new NotFoundError("Task", id);
      }
      res.json(task);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /tasks/:id — update task fields or status
  router.patch(
    "/:id",
    authenticate(),
    requirePermission("task:create"),
    validate(updateTaskSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const current = await db.query.tasks.findFirst({
          where: and(eq(tasks.id, id), eq(tasks.companyId, req.companyId!)),
        });
        if (!current) {
          throw new NotFoundError("Task", id);
        }

        // Validate status transition
        if (req.body.status) {
          validateTaskTransition(current.status as TaskStatus, req.body.status);
        }

        // Validate agent if being changed
        if (req.body.agentId) {
          const agent = await db.query.agents.findFirst({
            where: and(
              eq(agents.id, req.body.agentId),
              eq(agents.companyId, req.companyId!),
            ),
          });
          if (!agent) {
            throw new NotFoundError("Agent", req.body.agentId);
          }
        }

        // Set timestamps based on status changes
        const updates: Record<string, unknown> = { ...req.body, updatedAt: new Date() };
        if (req.body.status === "running" && current.status !== "running") {
          updates.startedAt = new Date();
        }
        if (
          (req.body.status === "completed" || req.body.status === "failed" || req.body.status === "cancelled") &&
          !current.completedAt
        ) {
          updates.completedAt = new Date();
        }
        if (req.body.status === "retrying") {
          updates.retryCount = (current.retryCount ?? 0) + 1;
        }

        const [updated] = await db
          .update(tasks)
          .set(updates)
          .where(and(eq(tasks.id, id), eq(tasks.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "task:update",
          resourceType: "task",
          resourceId: updated.id,
          departmentId: updated.departmentId,
          changes: { before: { status: current.status }, after: req.body },
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /tasks/:id/cancel — cancel a task
  router.post(
    "/:id/cancel",
    authenticate(),
    requirePermission("task:cancel"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const current = await db.query.tasks.findFirst({
          where: and(eq(tasks.id, id), eq(tasks.companyId, req.companyId!)),
        });
        if (!current) {
          throw new NotFoundError("Task", id);
        }

        validateTaskTransition(current.status as TaskStatus, "cancelled");

        const [updated] = await db
          .update(tasks)
          .set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(tasks.id, id), eq(tasks.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "task:cancel",
          resourceType: "task",
          resourceId: updated.id,
          departmentId: updated.departmentId,
          changes: { before: { status: current.status }, after: { status: "cancelled" } },
          riskLevel: "medium",
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /tasks/:id/retry — retry a failed task
  router.post(
    "/:id/retry",
    authenticate(),
    requirePermission("task:retry"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const current = await db.query.tasks.findFirst({
          where: and(eq(tasks.id, id), eq(tasks.companyId, req.companyId!)),
        });
        if (!current) {
          throw new NotFoundError("Task", id);
        }

        if (current.status !== "failed") {
          throw new ValidationError("Only failed tasks can be retried");
        }

        if ((current.retryCount ?? 0) >= (current.maxRetries ?? 3)) {
          throw new ValidationError(
            `Max retries (${current.maxRetries}) reached. Task has been retried ${current.retryCount} times.`,
          );
        }

        const [updated] = await db
          .update(tasks)
          .set({
            status: "retrying",
            retryCount: (current.retryCount ?? 0) + 1,
            error: null,
            output: null,
            completedAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.id, id), eq(tasks.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "task:retry",
          resourceType: "task",
          resourceId: updated.id,
          departmentId: updated.departmentId,
          changes: {
            before: { status: current.status, retryCount: current.retryCount },
            after: { status: "retrying", retryCount: updated.retryCount },
          },
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
