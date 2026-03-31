import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { departments, departmentMemberships, users } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ConflictError } from "../lib/errors.js";

const createDepartmentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  managerUserId: z.string().uuid().optional(),
});

const updateDepartmentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  managerUserId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["department_manager", "operator", "viewer"]).default("viewer"),
});

export function departmentRoutes() {
  const router = Router();

  // GET /departments
  router.get("/", authenticate(), requirePermission("department:view"), async (req, res, next) => {
    try {
      const db = getDb();

      const isCompanyWide = req.auth!.roles.some((r) =>
        ["oneops_admin", "customer_admin", "customer_user"].includes(r),
      );

      let depts;
      if (isCompanyWide) {
        depts = await db.query.departments.findMany({
          where: eq(departments.companyId, req.companyId!),
        });
      } else {
        const memberships = await db.query.departmentMemberships.findMany({
          where: eq(departmentMemberships.userId, req.userId!),
        });
        const deptIds = memberships.map((m) => m.departmentId);
        const allDepts = await db.query.departments.findMany({
          where: eq(departments.companyId, req.companyId!),
        });
        depts = allDepts.filter((d) => deptIds.includes(d.id));
      }

      res.json(depts);
    } catch (err) {
      next(err);
    }
  });

  // POST /departments
  router.post(
    "/",
    authenticate(),
    requirePermission("department:create"),
    validate(createDepartmentSchema),
    async (req, res, next) => {
      try {
        const db = getDb();

        const existing = await db.query.departments.findFirst({
          where: and(
            eq(departments.companyId, req.companyId!),
            eq(departments.name, req.body.name),
          ),
        });
        if (existing) {
          throw new ConflictError(`Department '${req.body.name}' already exists`);
        }

        const [dept] = await db
          .insert(departments)
          .values({
            companyId: req.companyId!,
            name: req.body.name,
            description: req.body.description,
            managerUserId: req.body.managerUserId,
          })
          .returning();

        await req.audit?.({
          action: "department:create",
          resourceType: "department",
          resourceId: dept.id,
          riskLevel: "medium",
        });

        res.status(201).json(dept);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /departments/:id
  router.get("/:id", authenticate(), requirePermission("department:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const id = req.params.id as string;
      const dept = await db.query.departments.findFirst({
        where: and(eq(departments.id, id), eq(departments.companyId, req.companyId!)),
      });
      if (!dept) {
        throw new NotFoundError("Department", id);
      }
      res.json(dept);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /departments/:id
  router.patch(
    "/:id",
    authenticate(),
    requirePermission("department:manage"),
    validate(updateDepartmentSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;
        const [updated] = await db
          .update(departments)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(departments.id, id), eq(departments.companyId, req.companyId!)))
          .returning();

        if (!updated) {
          throw new NotFoundError("Department", id);
        }

        await req.audit?.({
          action: "department:update",
          resourceType: "department",
          resourceId: updated.id,
          departmentId: updated.id,
          changes: { after: req.body },
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /departments/:id (archive)
  router.delete(
    "/:id",
    authenticate(),
    requirePermission("department:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;
        const [updated] = await db
          .update(departments)
          .set({ status: "archived", updatedAt: new Date() })
          .where(and(eq(departments.id, id), eq(departments.companyId, req.companyId!)))
          .returning();

        if (!updated) {
          throw new NotFoundError("Department", id);
        }

        await req.audit?.({
          action: "department:archive",
          resourceType: "department",
          resourceId: updated.id,
          departmentId: updated.id,
          riskLevel: "medium",
        });

        res.json({ message: "Department archived", department: updated });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /departments/:id/members
  router.post(
    "/:id/members",
    authenticate(),
    requirePermission("user:invite_dept"),
    validate(addMemberSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const deptId = req.params.id as string;

        const dept = await db.query.departments.findFirst({
          where: and(eq(departments.id, deptId), eq(departments.companyId, req.companyId!)),
        });
        if (!dept) {
          throw new NotFoundError("Department", deptId);
        }

        const user = await db.query.users.findFirst({
          where: and(eq(users.id, req.body.userId), eq(users.companyId, req.companyId!)),
        });
        if (!user) {
          throw new NotFoundError("User", req.body.userId);
        }

        const existing = await db.query.departmentMemberships.findFirst({
          where: and(
            eq(departmentMemberships.departmentId, deptId),
            eq(departmentMemberships.userId, req.body.userId),
          ),
        });
        if (existing) {
          throw new ConflictError("User is already a member of this department");
        }

        const [membership] = await db
          .insert(departmentMemberships)
          .values({
            companyId: req.companyId!,
            departmentId: deptId,
            userId: req.body.userId,
            role: req.body.role,
          })
          .returning();

        await req.audit?.({
          action: "department:member_add",
          resourceType: "department_membership",
          resourceId: membership.id,
          departmentId: deptId,
        });

        res.status(201).json(membership);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /departments/:id/members/:userId
  router.delete(
    "/:id/members/:userId",
    authenticate(),
    requirePermission("department:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const deptId = req.params.id as string;
        const userId = req.params.userId as string;

        const existing = await db.query.departmentMemberships.findFirst({
          where: and(
            eq(departmentMemberships.departmentId, deptId),
            eq(departmentMemberships.userId, userId),
          ),
        });

        if (!existing) {
          throw new NotFoundError("Membership");
        }

        await db.delete(departmentMemberships).where(eq(departmentMemberships.id, existing.id));

        await req.audit?.({
          action: "department:member_remove",
          resourceType: "department_membership",
          resourceId: existing.id,
          departmentId: deptId,
          riskLevel: "medium",
        });

        res.json({ message: "Member removed" });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /departments/:id/members
  router.get(
    "/:id/members",
    authenticate(),
    requirePermission("department:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const deptId = req.params.id as string;
        const members = await db.query.departmentMemberships.findMany({
          where: and(
            eq(departmentMemberships.departmentId, deptId),
            eq(departmentMemberships.companyId, req.companyId!),
          ),
        });
        res.json(members);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
