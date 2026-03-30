import type { Request, Response, NextFunction } from "express";
import {
  type Permission,
  type UserRole,
  ROLE_PERMISSIONS,
  DEPARTMENT_ROLE_PERMISSIONS,
} from "@agentops/shared";
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js";

/**
 * RBAC middleware that checks if the authenticated user has the required permission.
 *
 * For company-level roles (company_admin, technical_admin, auditor), permissions
 * are checked globally across the company.
 *
 * For department-scoped permissions (marked with * in the permission matrix),
 * the middleware also checks department membership if a departmentId is present
 * in the request params.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      return next(new UnauthorizedError());
    }

    const { roles, department_roles } = req.auth;

    // Check company-level roles first
    for (const role of roles) {
      const perms = ROLE_PERMISSIONS[role as UserRole];
      if (perms?.includes(permission)) {
        return next();
      }
    }

    // Check department-level roles if a department context exists
    const departmentId =
      req.params.departmentId || req.body?.departmentId || req.query.departmentId;

    if (departmentId && department_roles) {
      const deptRole = department_roles[departmentId as string];
      if (deptRole) {
        const deptPerms = DEPARTMENT_ROLE_PERMISSIONS[deptRole];
        if (deptPerms?.includes(permission)) {
          return next();
        }
      }
    }

    // If no department context but user has department-level permissions,
    // allow if they have the permission in ANY department
    if (!departmentId && department_roles) {
      for (const deptRole of Object.values(department_roles)) {
        const deptPerms = DEPARTMENT_ROLE_PERMISSIONS[deptRole];
        if (deptPerms?.includes(permission)) {
          return next();
        }
      }
    }

    next(new ForbiddenError(`Missing permission: ${permission}`));
  };
}
