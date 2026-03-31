import type { Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { departmentMemberships, agents, tasks } from "@agentops/db";
import { type UserRole, ROLE_PERMISSIONS } from "@agentops/shared";
import { ForbiddenError } from "../lib/errors.js";
import { getDb } from "../lib/db.js";

/**
 * Middleware that enforces department-scoped access.
 *
 * Company-level roles (oneops_admin, customer_admin) bypass department checks.
 * Other users must be a member of the department the resource belongs to.
 *
 * The departmentId is resolved from:
 * 1. req.body.departmentId (for create/update)
 * 2. The resource's departmentId (for existing agents/tasks)
 *
 * This middleware should run AFTER authenticate() and requirePermission().
 */
export function requireDepartmentAccess(resourceType: "agent" | "task") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      return next(new ForbiddenError("Authentication required"));
    }

    // Company-level roles bypass department scope
    const companyRoles: UserRole[] = ["oneops_admin", "customer_admin"];
    if (req.auth.roles.some((r) => companyRoles.includes(r as UserRole))) {
      return next();
    }

    // Customer Users have read-only access across all departments
    if (req.auth.roles.includes("customer_user" as UserRole)) {
      return next();
    }

    // Determine the department ID
    let departmentId: string | undefined;

    if (req.body?.departmentId) {
      departmentId = req.body.departmentId;
    } else if (req.params.id) {
      // Look up the resource to find its department
      const db = getDb();
      const resourceId = req.params.id as string;
      if (resourceType === "agent") {
        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, resourceId), eq(agents.companyId, req.companyId!)),
        });
        departmentId = agent?.departmentId ?? undefined;
      } else if (resourceType === "task") {
        const task = await db.query.tasks.findFirst({
          where: and(eq(tasks.id, resourceId), eq(tasks.companyId, req.companyId!)),
        });
        departmentId = task?.departmentId;
      }
    }

    // If no department context, allow (the resource isn't department-scoped)
    if (!departmentId) {
      return next();
    }

    // Check if user has a department role for this department
    const deptRole = req.auth.department_roles?.[departmentId];
    if (deptRole) {
      return next();
    }

    // Double-check against DB (JWT might be stale)
    const db = getDb();
    const membership = await db.query.departmentMemberships.findFirst({
      where: and(
        eq(departmentMemberships.userId, req.userId!),
        eq(departmentMemberships.departmentId, departmentId),
      ),
    });

    if (membership) {
      return next();
    }

    next(new ForbiddenError("Access denied: you are not a member of this department"));
  };
}
