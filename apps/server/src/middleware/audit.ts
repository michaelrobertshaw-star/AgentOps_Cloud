import type { Request, Response, NextFunction } from "express";
import { writeAuditLog } from "../services/auditService.js";

export function auditMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.audit = async (params) => {
      if (!req.companyId || !req.userId) return;

      await writeAuditLog({
        companyId: req.companyId,
        actorType: "user",
        actorId: req.userId,
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        departmentId: params.departmentId,
        changes: params.changes,
        riskLevel: params.riskLevel ?? "low",
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.requestId,
      }).catch((err) => {
        console.error("Audit log write failed:", err);
      });
    };
    next();
  };
}
