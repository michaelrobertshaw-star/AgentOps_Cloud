import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { workspaces, departments } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ConflictError } from "../lib/errors.js";

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
});

/**
 * Department-scoped workspace routes.
 * Mount at: /api/departments/:deptId/workspaces
 */
export function workspaceDeptRoutes() {
  const router = Router({ mergeParams: true });

  // POST /api/departments/:deptId/workspaces — create workspace
  router.post(
    "/",
    authenticate(),
    requirePermission("workspace:write"),
    validate(createWorkspaceSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const deptId = req.params.deptId as string;

        // Verify department belongs to company
        const dept = await db.query.departments.findFirst({
          where: and(
            eq(departments.id, deptId),
            eq(departments.companyId, req.companyId!),
          ),
        });
        if (!dept) {
          throw new NotFoundError("Department", deptId);
        }

        // Check for duplicate name in this department
        const existing = await db.query.workspaces.findFirst({
          where: and(
            eq(workspaces.departmentId, deptId),
            eq(workspaces.name, req.body.name),
            eq(workspaces.companyId, req.companyId!),
          ),
        });
        if (existing) {
          throw new ConflictError(`Workspace '${req.body.name}' already exists in this department`);
        }

        // Pre-generate ID so storagePath can reference it
        const id = randomUUID();
        const storagePath = `${req.companyId}/departments/${deptId}/workspaces/${id}`;

        const [workspace] = await db
          .insert(workspaces)
          .values({
            id,
            companyId: req.companyId!,
            departmentId: deptId,
            name: req.body.name,
            description: req.body.description,
            storagePath,
          })
          .returning();

        await req.audit?.({
          action: "workspace:create",
          resourceType: "workspace",
          resourceId: workspace.id,
          departmentId: deptId,
          riskLevel: "medium",
        });

        res.status(201).json(workspace);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/departments/:deptId/workspaces — list workspaces for department
  router.get(
    "/",
    authenticate(),
    requirePermission("workspace:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const deptId = req.params.deptId as string;

        // Verify department belongs to company
        const dept = await db.query.departments.findFirst({
          where: and(
            eq(departments.id, deptId),
            eq(departments.companyId, req.companyId!),
          ),
        });
        if (!dept) {
          throw new NotFoundError("Department", deptId);
        }

        const results = await db.query.workspaces.findMany({
          where: and(
            eq(workspaces.departmentId, deptId),
            eq(workspaces.companyId, req.companyId!),
          ),
        });

        res.json(results);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/**
 * Top-level workspace routes.
 * Mount at: /api/workspaces
 */
export function workspaceRoutes() {
  const router = Router();

  // GET /api/workspaces/:id — get workspace details
  router.get("/:id", authenticate(), requirePermission("workspace:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const id = req.params.id as string;

      const workspace = await db.query.workspaces.findFirst({
        where: and(
          eq(workspaces.id, id),
          eq(workspaces.companyId, req.companyId!),
        ),
      });
      if (!workspace) {
        throw new NotFoundError("Workspace", id);
      }

      res.json(workspace);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/workspaces/:id — update workspace
  router.patch(
    "/:id",
    authenticate(),
    requirePermission("workspace:write"),
    validate(updateWorkspaceSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const [updated] = await db
          .update(workspaces)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(workspaces.id, id), eq(workspaces.companyId, req.companyId!)))
          .returning();

        if (!updated) {
          throw new NotFoundError("Workspace", id);
        }

        await req.audit?.({
          action: "workspace:update",
          resourceType: "workspace",
          resourceId: updated.id,
          departmentId: updated.departmentId,
          changes: { after: req.body },
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/workspaces/:id — archive workspace (soft delete)
  router.delete(
    "/:id",
    authenticate(),
    requirePermission("workspace:write"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const [updated] = await db
          .update(workspaces)
          .set({ status: "archived", updatedAt: new Date() })
          .where(
            and(
              eq(workspaces.id, id),
              eq(workspaces.companyId, req.companyId!),
            ),
          )
          .returning();

        if (!updated) {
          throw new NotFoundError("Workspace", id);
        }

        await req.audit?.({
          action: "workspace:archive",
          resourceType: "workspace",
          resourceId: updated.id,
          departmentId: updated.departmentId,
          riskLevel: "medium",
        });

        res.json({ message: "Workspace archived", workspace: updated });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
