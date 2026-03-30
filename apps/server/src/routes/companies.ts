import { Router } from "express";
import { z } from "zod";
import { eq, and, gte, sql } from "drizzle-orm";
import { companies, agents, tasks, departments } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError } from "../lib/errors.js";

const updateCompanySchema = z.object({
  displayName: z.string().min(2).max(255).optional(),
  settings: z.record(z.unknown()).optional(),
  timezone: z.string().max(50).optional(),
  region: z.string().max(50).optional(),
});

export function companyRoutes() {
  const router = Router();

  // GET /companies/me
  router.get("/me", authenticate(), requirePermission("company:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const company = await db.query.companies.findFirst({
        where: eq(companies.id, req.companyId!),
      });
      if (!company) {
        throw new NotFoundError("Company");
      }
      res.json(company);
    } catch (err) {
      next(err);
    }
  });

  // GET /companies/me/dashboard
  router.get(
    "/me/dashboard",
    authenticate(),
    requirePermission("company:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.companyId!;
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [company, agentRows, taskRows, deptRows] = await Promise.all([
          db.query.companies.findFirst({ where: eq(companies.id, companyId) }),

          // Agent status counts
          db
            .select({ status: agents.status, count: sql<number>`count(*)::int` })
            .from(agents)
            .where(eq(agents.companyId, companyId))
            .groupBy(agents.status),

          // Task status counts (last 24h)
          db
            .select({ status: tasks.status, count: sql<number>`count(*)::int` })
            .from(tasks)
            .where(and(eq(tasks.companyId, companyId), gte(tasks.createdAt, since24h)))
            .groupBy(tasks.status),

          // Department summary
          db
            .select({
              id: departments.id,
              name: departments.name,
              status: departments.status,
              agentCount: sql<number>`(
                select count(*) from agents a
                where a.department_id = ${departments.id}
              )::int`,
              taskCount24h: sql<number>`(
                select count(*) from tasks t
                where t.department_id = ${departments.id}
                  and t.created_at >= ${since24h}
              )::int`,
            })
            .from(departments)
            .where(eq(departments.companyId, companyId))
            .orderBy(departments.name),
        ]);

        if (!company) throw new NotFoundError("Company");

        // Build agent status map
        const agentCounts: Record<string, number> = {};
        let totalAgents = 0;
        for (const row of agentRows) {
          agentCounts[row.status] = row.count;
          totalAgents += row.count;
        }

        // Build task status map
        const taskCounts: Record<string, number> = {};
        let total24h = 0;
        for (const row of taskRows) {
          taskCounts[row.status] = row.count;
          total24h += row.count;
        }

        res.json({
          company: { id: company.id, name: company.name, displayName: company.displayName },
          agents: {
            total: totalAgents,
            active: agentCounts["active"] ?? 0,
            paused: agentCounts["paused"] ?? 0,
            error: agentCounts["error"] ?? 0,
            draft: agentCounts["draft"] ?? 0,
            testing: agentCounts["testing"] ?? 0,
          },
          tasks: {
            total24h,
            pending: taskCounts["pending"] ?? 0,
            running: taskCounts["running"] ?? 0,
            completed: taskCounts["completed"] ?? 0,
            failed: taskCounts["failed"] ?? 0,
          },
          departments: deptRows,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH /companies/me
  router.patch(
    "/me",
    authenticate(),
    requirePermission("company:manage"),
    validate(updateCompanySchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const [updated] = await db
          .update(companies)
          .set({ ...req.body, updatedAt: new Date() })
          .where(eq(companies.id, req.companyId!))
          .returning();

        if (!updated) {
          throw new NotFoundError("Company");
        }

        await req.audit?.({
          action: "company:update",
          resourceType: "company",
          resourceId: updated.id,
          changes: { after: req.body },
          riskLevel: "medium",
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
