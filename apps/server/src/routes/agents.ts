import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { agents, departments } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ConflictError, ValidationError } from "../lib/errors.js";
import type { AgentStatus } from "@agentops/shared";

const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.string().min(1).max(50),
  version: z.string().max(50).optional(),
  description: z.string().max(2000).optional(),
  departmentId: z.string().uuid().optional(),
  executionPolicy: z
    .object({
      max_concurrent_tasks: z.number().int().min(1).max(100).default(1),
      timeout_seconds: z.number().int().min(30).max(86400).default(1800),
      retry_policy: z
        .object({
          max_retries: z.number().int().min(0).max(10).default(3),
          backoff: z.enum(["exponential", "linear", "fixed"]).default("exponential"),
        })
        .default({}),
    })
    .default({}),
  capabilities: z.array(z.string()).default([]),
  config: z.record(z.unknown()).default({}),
});

const updateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.string().min(1).max(50).optional(),
  version: z.string().max(50).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  status: z
    .enum(["draft", "testing", "tested", "active", "degraded", "paused", "stopped", "error", "archived", "deployed", "disabled"])
    .optional(),
  executionPolicy: z
    .object({
      max_concurrent_tasks: z.number().int().min(1).max(100).optional(),
      timeout_seconds: z.number().int().min(30).max(86400).optional(),
      retry_policy: z
        .object({
          max_retries: z.number().int().min(0).max(10).optional(),
          backoff: z.enum(["exponential", "linear", "fixed"]).optional(),
        })
        .optional(),
    })
    .optional(),
  capabilities: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
});

// Valid status transitions for agents
const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  draft: ["testing", "archived"],
  testing: ["active", "tested", "draft", "archived"],
  tested: ["deployed", "draft", "archived"],
  active: ["paused", "stopped", "degraded", "error", "archived"],
  degraded: ["active", "error", "stopped", "archived"],
  paused: ["active", "testing", "stopped", "archived"],
  stopped: ["draft", "archived"],
  error: ["stopped", "draft", "archived"],
  archived: [],
  deployed: ["disabled", "tested", "archived"],
  disabled: ["tested", "archived"],
};

function validateStatusTransition(current: AgentStatus, next: AgentStatus): void {
  if (current === next) return;
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new ValidationError(
      `Invalid status transition from '${current}' to '${next}'. Allowed: ${allowed.join(", ") || "none"}`,
    );
  }
}

export function agentRoutes() {
  const router = Router();

  // GET /agents — list agents for the company
  router.get("/", authenticate(), requirePermission("agent:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const allAgents = await db.query.agents.findMany({
        where: eq(agents.companyId, req.companyId!),
      });

      // Filter by query params
      let result = allAgents;
      if (req.query.departmentId) {
        result = result.filter((a) => a.departmentId === req.query.departmentId);
      }
      if (req.query.status) {
        result = result.filter((a) => a.status === req.query.status);
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /agents — create a new agent
  router.post(
    "/",
    authenticate(),
    requirePermission("agent:create"),
    validate(createAgentSchema),
    async (req, res, next) => {
      try {
        const db = getDb();

        // Check for duplicate name within company
        const existing = await db.query.agents.findFirst({
          where: and(eq(agents.companyId, req.companyId!), eq(agents.name, req.body.name)),
        });
        if (existing) {
          throw new ConflictError(`Agent '${req.body.name}' already exists`);
        }

        // Validate department if provided
        if (req.body.departmentId) {
          const dept = await db.query.departments.findFirst({
            where: and(
              eq(departments.id, req.body.departmentId),
              eq(departments.companyId, req.companyId!),
            ),
          });
          if (!dept) {
            throw new NotFoundError("Department", req.body.departmentId);
          }
        }

        const [agent] = await db
          .insert(agents)
          .values({
            companyId: req.companyId!,
            name: req.body.name,
            type: req.body.type,
            version: req.body.version,
            description: req.body.description,
            departmentId: req.body.departmentId,
            executionPolicy: req.body.executionPolicy,
            capabilities: req.body.capabilities,
            config: req.body.config,
          })
          .returning();

        await req.audit?.({
          action: "agent:create",
          resourceType: "agent",
          resourceId: agent.id,
          departmentId: agent.departmentId ?? undefined,
          riskLevel: "medium",
        });

        res.status(201).json(agent);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /agents/:id — get a single agent
  router.get("/:id", authenticate(), requirePermission("agent:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const id = req.params.id as string;
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, id), eq(agents.companyId, req.companyId!)),
      });
      if (!agent) {
        throw new NotFoundError("Agent", id);
      }
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /agents/:id — update agent fields or status
  router.patch(
    "/:id",
    authenticate(),
    requirePermission("agent:manage"),
    validate(updateAgentSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        // Fetch current agent for status transition validation
        const current = await db.query.agents.findFirst({
          where: and(eq(agents.id, id), eq(agents.companyId, req.companyId!)),
        });
        if (!current) {
          throw new NotFoundError("Agent", id);
        }

        // Validate status transition if status is being changed
        if (req.body.status) {
          validateStatusTransition(current.status as AgentStatus, req.body.status);
        }

        // Validate department if being changed
        if (req.body.departmentId) {
          const dept = await db.query.departments.findFirst({
            where: and(
              eq(departments.id, req.body.departmentId),
              eq(departments.companyId, req.companyId!),
            ),
          });
          if (!dept) {
            throw new NotFoundError("Department", req.body.departmentId);
          }
        }

        // Check name uniqueness if name is being changed
        if (req.body.name && req.body.name !== current.name) {
          const nameExists = await db.query.agents.findFirst({
            where: and(eq(agents.companyId, req.companyId!), eq(agents.name, req.body.name)),
          });
          if (nameExists) {
            throw new ConflictError(`Agent '${req.body.name}' already exists`);
          }
        }

        const [updated] = await db
          .update(agents)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(agents.id, id), eq(agents.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "agent:update",
          resourceType: "agent",
          resourceId: updated.id,
          departmentId: updated.departmentId ?? undefined,
          changes: { before: { status: current.status }, after: req.body },
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /agents/:id — archive an agent
  router.delete(
    "/:id",
    authenticate(),
    requirePermission("agent:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const current = await db.query.agents.findFirst({
          where: and(eq(agents.id, id), eq(agents.companyId, req.companyId!)),
        });
        if (!current) {
          throw new NotFoundError("Agent", id);
        }
        if (current.status === "archived") {
          throw new ConflictError("Agent is already archived");
        }

        const [updated] = await db
          .update(agents)
          .set({ status: "archived", updatedAt: new Date() })
          .where(and(eq(agents.id, id), eq(agents.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "agent:archive",
          resourceType: "agent",
          resourceId: updated.id,
          departmentId: updated.departmentId ?? undefined,
          riskLevel: "medium",
        });

        res.json({ message: "Agent archived", agent: updated });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /agents/:id/pause — pause an active/degraded agent
  router.post(
    "/:id/pause",
    authenticate(),
    requirePermission("agent:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const current = await db.query.agents.findFirst({
          where: and(eq(agents.id, id), eq(agents.companyId, req.companyId!)),
        });
        if (!current) {
          throw new NotFoundError("Agent", id);
        }

        validateStatusTransition(current.status as AgentStatus, "paused");

        const [updated] = await db
          .update(agents)
          .set({ status: "paused", updatedAt: new Date() })
          .where(and(eq(agents.id, id), eq(agents.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "agent:pause",
          resourceType: "agent",
          resourceId: updated.id,
          departmentId: updated.departmentId ?? undefined,
          changes: { before: { status: current.status }, after: { status: "paused" } },
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /agents/:id/resume — resume a paused agent back to active
  router.post(
    "/:id/resume",
    authenticate(),
    requirePermission("agent:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const current = await db.query.agents.findFirst({
          where: and(eq(agents.id, id), eq(agents.companyId, req.companyId!)),
        });
        if (!current) {
          throw new NotFoundError("Agent", id);
        }

        if (current.status !== "paused") {
          throw new ValidationError("Agent must be paused to resume");
        }

        const [updated] = await db
          .update(agents)
          .set({ status: "active", updatedAt: new Date() })
          .where(and(eq(agents.id, id), eq(agents.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "agent:resume",
          resourceType: "agent",
          resourceId: updated.id,
          departmentId: updated.departmentId ?? undefined,
          changes: { before: { status: "paused" }, after: { status: "active" } },
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
