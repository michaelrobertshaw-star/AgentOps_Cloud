/**
 * M6.6 — Deployment Flow
 *
 * POST /api/agents/:agentId/deploy   — promote agent to deployed
 * POST /api/agents/:agentId/undeploy — roll back to tested
 * GET  /api/companies/:companyId/deployed-agents — list deployed agents
 */

import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { agents } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ForbiddenError, AppError } from "../lib/errors.js";

// ================================================================
// Agent deploy routes: /api/agents/:agentId
// ================================================================

export function agentDeployRoutes() {
  const router = Router({ mergeParams: true });

  // POST /api/agents/:agentId/deploy — promote agent from tested → deployed
  router.post(
    "/deploy",
    authenticate(),
    requirePermission("agent:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const agentId = req.params.agentId as string;

        const current = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, req.companyId!)),
        });
        if (!current) {
          throw new NotFoundError("Agent", agentId);
        }

        if (current.status !== "tested") {
          throw new AppError(422, "INVALID_STATE", "Agent must be in 'tested' state to deploy");
        }

        const [updated] = await db
          .update(agents)
          .set({
            status: "deployed",
            deployedAt: new Date(),
            deployedByUserId: req.userId ?? null,
            updatedAt: new Date(),
          })
          .where(and(eq(agents.id, agentId), eq(agents.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "agent:deploy",
          resourceType: "agent",
          resourceId: updated.id,
          departmentId: updated.departmentId ?? undefined,
          riskLevel: "high",
          changes: { before: { status: "tested" }, after: { status: "deployed" } },
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/agents/:agentId/undeploy — roll back deployed → tested
  router.post(
    "/undeploy",
    authenticate(),
    requirePermission("agent:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const agentId = req.params.agentId as string;

        const current = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, req.companyId!)),
        });
        if (!current) {
          throw new NotFoundError("Agent", agentId);
        }

        if (current.status !== "deployed") {
          throw new AppError(422, "INVALID_STATE", "Agent must be in 'deployed' state to undeploy");
        }

        const [updated] = await db
          .update(agents)
          .set({
            status: "tested",
            deployedAt: null,
            deployedByUserId: null,
            updatedAt: new Date(),
          })
          .where(and(eq(agents.id, agentId), eq(agents.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "agent:undeploy",
          resourceType: "agent",
          resourceId: updated.id,
          departmentId: updated.departmentId ?? undefined,
          riskLevel: "high",
          changes: { before: { status: "deployed" }, after: { status: "tested" } },
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ================================================================
// Company deployed-agents route: /api/companies/:companyId/deployed-agents
// ================================================================

export function companyDeployedAgentsRoute() {
  const router = Router({ mergeParams: true });

  // GET /api/companies/:companyId/deployed-agents — list deployed agents for a company
  router.get(
    "/",
    authenticate(),
    requirePermission("agent:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.params.companyId as string;

        if (companyId !== req.companyId) {
          throw new ForbiddenError("Access denied to this company's resources");
        }

        const deployedAgents = await db.query.agents.findMany({
          where: and(eq(agents.companyId, companyId), eq(agents.status, "deployed")),
          orderBy: (a, { desc }) => [desc(a.deployedAt)],
        });

        res.json(deployedAgents);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
