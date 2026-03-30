import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { queryAuditLogs } from "../services/auditService.js";

export function auditRoutes() {
  const router = Router();

  // GET /audit-logs
  router.get("/", authenticate(), requirePermission("audit:view"), async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 50), 100);
      const cursor = req.query.cursor as string | undefined;
      const action = req.query.action as string | undefined;
      const resourceType = req.query.resourceType as string | undefined;
      const resourceId = req.query.resourceId as string | undefined;

      const result = await queryAuditLogs(req.companyId!, {
        limit,
        cursor,
        action,
        resourceType,
        resourceId,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
