import type { Request } from "express";
import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { queryAuditLogs, verifyAuditLogChain } from "../services/auditService.js";
import { enqueueVerifyChain, enqueueArchive, listAuditArchives } from "../services/auditArchiveService.js";
import { ForbiddenError } from "../lib/errors.js";

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
      const actorId = req.query.actorId as string | undefined;
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;

      const result = await queryAuditLogs(req.companyId!, {
        limit,
        cursor,
        action,
        resourceType,
        resourceId,
        actorId,
        from,
        to,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Company-scoped audit log routes.
 * Mount at: /api/companies/:companyId/audit-logs
 */
export function auditCompanyRoutes() {
  const router = Router({ mergeParams: true });

  // GET /api/companies/:companyId/audit-logs
  router.get(
    "/",
    authenticate(),
    requirePermission("audit:view"),
    async (req, res, next) => {
      try {
        // Ensure the user is querying their own company
        if (req.params.companyId !== req.companyId) {
          throw new ForbiddenError("Cannot access audit logs for another company");
        }

        const limit = Math.min(Number(req.query.limit ?? 50), 100);
        const cursor = req.query.cursor as string | undefined;
        const action = req.query.action as string | undefined;
        // Support both entityType/entityId (AC) and resourceType/resourceId (legacy)
        const resourceType = (req.query.entityType ?? req.query.resourceType) as string | undefined;
        const resourceId = (req.query.entityId ?? req.query.resourceId) as string | undefined;
        const actorId = req.query.actorId as string | undefined;
        const from = req.query.from as string | undefined;
        const to = req.query.to as string | undefined;

        const result = await queryAuditLogs(req.companyId!, {
          limit,
          cursor,
          action,
          resourceType,
          resourceId,
          actorId,
          from,
          to,
        });

        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/companies/:companyId/audit-logs/verify — hash chain verification (sync, lightweight)
  router.get(
    "/verify",
    authenticate(),
    requirePermission("audit:view"),
    async (req, res, next) => {
      try {
        if (req.params.companyId !== req.companyId) {
          throw new ForbiddenError("Cannot verify audit logs for another company");
        }

        const result = await verifyAuditLogChain(req.companyId!);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/**
 * Audit archive routes (async hash-chain verification + S3 archival).
 * Mount at: /api/companies/:companyId/audit
 */
export function auditArchiveCompanyRoutes() {
  const router = Router({ mergeParams: true });

  function checkCompany(req: Request): void {
    if (req.params.companyId !== req.companyId) {
      throw new ForbiddenError("Cannot access audit data for another company");
    }
  }

  // GET /api/companies/:companyId/audit/verify-chain
  // Enqueues an async hash-chain verification job and returns the job ID immediately.
  router.get(
    "/verify-chain",
    authenticate(),
    requirePermission("audit:view"),
    async (req, res, next) => {
      try {
        checkCompany(req);
        const jobId = await enqueueVerifyChain(req.companyId!);
        res.status(202).json({ jobId, message: "Hash-chain verification enqueued" });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/companies/:companyId/audit/archive
  // Triggers an async archival job for entries older than the company's retention policy.
  router.post(
    "/archive",
    authenticate(),
    requirePermission("audit:manage"),
    async (req, res, next) => {
      try {
        checkCompany(req);
        const jobId = await enqueueArchive(req.companyId!);
        res.status(202).json({ jobId, message: "Audit log archival enqueued" });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/companies/:companyId/audit/archived
  // Lists archive files in S3 for this company.
  router.get(
    "/archived",
    authenticate(),
    requirePermission("audit:view"),
    async (req, res, next) => {
      try {
        checkCompany(req);
        const archives = await listAuditArchives(req.companyId!);
        res.json({ archives });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
