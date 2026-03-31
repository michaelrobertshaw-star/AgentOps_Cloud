import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { incidents, incidentAttachments, departments, workspaceFiles } from "@agentops/db";
import { ROLE_PERMISSIONS, DEPARTMENT_ROLE_PERMISSIONS } from "@agentops/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";

// ================================================================
// Valid status transitions
// ================================================================
const TRANSITIONS: Record<string, string[]> = {
  open: ["investigating"],
  investigating: ["mitigated", "resolved"],
  mitigated: ["resolved"],
  resolved: ["closed"],
  closed: [],
};

// Status transitions that require incident:manage (managers+)
const MANAGE_TRANSITIONS = new Set(["investigating", "mitigated", "resolved"]);

// ================================================================
// Schemas
// ================================================================
const createIncidentSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  taskId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
});

const updateIncidentSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().min(1).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  status: z.enum(["open", "investigating", "mitigated", "resolved", "closed"]).optional(),
  resolution: z.string().optional(),
});

const attachFileSchema = z.object({
  workspaceFileId: z.string().uuid(),
});

// ================================================================
// Department-scoped routes
// Mount at: /api/departments/:deptId/incidents
// ================================================================
export function incidentDeptRoutes() {
  const router = Router({ mergeParams: true });

  // POST /api/departments/:deptId/incidents
  router.post(
    "/",
    authenticate(),
    requirePermission("incident:create"),
    validate(createIncidentSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const deptId = req.params.deptId as string;

        const dept = await db.query.departments.findFirst({
          where: and(
            eq(departments.id, deptId),
            eq(departments.companyId, req.companyId!),
          ),
        });
        if (!dept) throw new NotFoundError("Department", deptId);

        const [incident] = await db
          .insert(incidents)
          .values({
            companyId: req.companyId!,
            departmentId: deptId,
            title: req.body.title,
            description: req.body.description,
            severity: req.body.severity,
            status: "open",
            taskId: req.body.taskId ?? null,
            agentId: req.body.agentId ?? null,
          })
          .returning();

        // Notification stub: log critical severity incidents
        if (req.body.severity === "critical") {
          console.warn(`[incident:critical] Incident ${incident.id} created with critical severity`);
        }

        await req.audit?.({
          action: "incident:create",
          resourceType: "incident",
          resourceId: incident.id,
          departmentId: deptId,
          riskLevel: req.body.severity === "critical" ? "critical" : "medium",
        });

        res.status(201).json(incident);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/departments/:deptId/incidents
  router.get(
    "/",
    authenticate(),
    requirePermission("incident:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const deptId = req.params.deptId as string;

        const dept = await db.query.departments.findFirst({
          where: and(
            eq(departments.id, deptId),
            eq(departments.companyId, req.companyId!),
          ),
        });
        if (!dept) throw new NotFoundError("Department", deptId);

        const statusFilter = req.query.status as string | undefined;
        const severityFilter = req.query.severity as string | undefined;
        const page = Math.max(1, parseInt(req.query.page as string ?? "1"));
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string ?? "20")));
        const offset = (page - 1) * limit;

        const all = await db.query.incidents.findMany({
          where: and(
            eq(incidents.departmentId, deptId),
            eq(incidents.companyId, req.companyId!),
          ),
        });

        let filtered = all;
        if (statusFilter) {
          const validStatuses = ["open", "investigating", "mitigated", "resolved", "closed"];
          if (!validStatuses.includes(statusFilter)) {
            throw new ValidationError(`Invalid status filter: ${statusFilter}`);
          }
          filtered = filtered.filter((i) => i.status === statusFilter);
        }
        if (severityFilter) {
          const validSeverities = ["critical", "high", "medium", "low"];
          if (!validSeverities.includes(severityFilter)) {
            throw new ValidationError(`Invalid severity filter: ${severityFilter}`);
          }
          filtered = filtered.filter((i) => i.severity === severityFilter);
        }

        const total = filtered.length;
        const data = filtered.slice(offset, offset + limit);

        res.json({ data, total, page, limit });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ================================================================
// Global incident routes
// Mount at: /api/incidents
// ================================================================
export function incidentRoutes() {
  const router = Router();

  // GET /api/incidents/:id
  router.get("/:id", authenticate(), requirePermission("incident:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const id = req.params.id as string;

      const incident = await db.query.incidents.findFirst({
        where: and(eq(incidents.id, id), eq(incidents.companyId, req.companyId!)),
      });
      if (!incident) throw new NotFoundError("Incident", id);

      const attachments = await db.query.incidentAttachments.findMany({
        where: eq(incidentAttachments.incidentId, id),
      });

      res.json({ ...incident, attachments });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/incidents/:id
  router.patch(
    "/:id",
    authenticate(),
    requirePermission("incident:create"),
    validate(updateIncidentSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const incident = await db.query.incidents.findFirst({
          where: and(eq(incidents.id, id), eq(incidents.companyId, req.companyId!)),
        });
        if (!incident) throw new NotFoundError("Incident", id);

        const { status: newStatus, ...rest } = req.body;

        // Validate and enforce RBAC on status transitions
        if (newStatus && newStatus !== incident.status) {
          const allowed = TRANSITIONS[incident.status];
          if (!allowed?.includes(newStatus)) {
            throw new ValidationError(
              `Invalid status transition: ${incident.status} → ${newStatus}`,
              { allowed },
            );
          }

          // Closing requires oneops_admin
          if (newStatus === "closed") {
            const isAdmin = req.auth!.roles.includes("oneops_admin");
            if (!isAdmin) {
              throw new ForbiddenError("Only oneops_admin can close incidents");
            }
          }

          // Investigating/mitigated/resolved require incident:manage
          if (MANAGE_TRANSITIONS.has(newStatus)) {
            const auth = req.auth!;
            const hasManage =
              auth.roles.some((r) => ROLE_PERMISSIONS[r as keyof typeof ROLE_PERMISSIONS]?.includes("incident:manage")) ||
              Object.values(auth.department_roles ?? {}).some((deptRole) =>
                DEPARTMENT_ROLE_PERMISSIONS[deptRole as keyof typeof DEPARTMENT_ROLE_PERMISSIONS]?.includes("incident:manage"),
              );
            if (!hasManage) {
              throw new ForbiddenError("Missing permission: incident:manage");
            }
          }
        }

        // Build update payload
        const updatePayload: Record<string, unknown> = { ...rest, updatedAt: new Date() };
        if (newStatus) {
          updatePayload.status = newStatus;
          if (newStatus === "resolved") {
            updatePayload.resolvedAt = new Date();
            updatePayload.resolvedByUserId = req.userId ?? null;
          }
        }

        // Notification stub: log when transitioning to critical severity or resolving
        if (rest.severity === "critical" && incident.severity !== "critical") {
          console.warn(`[incident:escalated] Incident ${id} escalated to critical severity`);
        }

        const [updated] = await db
          .update(incidents)
          .set(updatePayload)
          .where(and(eq(incidents.id, id), eq(incidents.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "incident:update",
          resourceType: "incident",
          resourceId: id,
          departmentId: incident.departmentId ?? undefined,
          changes: { before: { status: incident.status }, after: { status: updated.status } },
          riskLevel: newStatus === "closed" ? "high" : "medium",
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/incidents/:id/attachments
  router.post(
    "/:id/attachments",
    authenticate(),
    requirePermission("incident:manage"),
    validate(attachFileSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const incident = await db.query.incidents.findFirst({
          where: and(eq(incidents.id, id), eq(incidents.companyId, req.companyId!)),
        });
        if (!incident) throw new NotFoundError("Incident", id);

        const file = await db.query.workspaceFiles.findFirst({
          where: and(
            eq(workspaceFiles.id, req.body.workspaceFileId),
            eq(workspaceFiles.companyId, req.companyId!),
          ),
        });
        if (!file) throw new NotFoundError("WorkspaceFile", req.body.workspaceFileId);

        const existing = await db.query.incidentAttachments.findFirst({
          where: and(
            eq(incidentAttachments.incidentId, id),
            eq(incidentAttachments.workspaceFileId, req.body.workspaceFileId),
          ),
        });
        if (existing) throw new ConflictError("File is already attached to this incident");

        const [attachment] = await db
          .insert(incidentAttachments)
          .values({
            companyId: req.companyId!,
            incidentId: id,
            workspaceFileId: req.body.workspaceFileId,
            attachedByUserId: req.userId ?? null,
          })
          .returning();

        await req.audit?.({
          action: "incident:attach_file",
          resourceType: "incident_attachment",
          resourceId: attachment.id,
          departmentId: incident.departmentId ?? undefined,
        });

        res.status(201).json(attachment);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
