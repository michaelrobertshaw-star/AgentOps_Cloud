/**
 * M6.7 — Usage + Spend Dashboard
 *
 * Token usage and cost tracking per agent, per company, per time range.
 * Reads from agent_runs table (populated by M6.4 execution engine).
 * Spend cap enforcement: blocks runs that exceed company cap (HTTP 402).
 */

import { Router } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { agentRuns, agents, companies, companySettings } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { getDb } from "../lib/db.js";
import type { Request } from "express";

// ================================================================
// Helpers
// ================================================================

function parseDateRange(req: Request): { from?: Date; to?: Date } {
  const from = req.query.from ? new Date(req.query.from as string) : undefined;
  const to = req.query.to ? new Date(req.query.to as string) : undefined;
  return { from, to };
}

// ================================================================
// Usage routes: /api/usage
// ================================================================

export function usageRoutes() {
  const router = Router();

  // GET /api/usage/summary — platform-wide totals (tokens, cost, run count)
  router.get(
    "/summary",
    authenticate(),
    requirePermission("company:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const { from, to } = parseDateRange(req);
        const companyId = req.companyId!;

        const conditions = [eq(agentRuns.companyId, companyId)];
        if (from) conditions.push(gte(agentRuns.startedAt, from));
        if (to) conditions.push(lte(agentRuns.startedAt, to));

        const [summary] = await db
          .select({
            totalRuns: sql<number>`count(*)::int`,
            totalTokensInput: sql<number>`coalesce(sum(${agentRuns.tokensInput}), 0)::int`,
            totalTokensOutput: sql<number>`coalesce(sum(${agentRuns.tokensOutput}), 0)::int`,
            totalCostUsd: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)::text`,
          })
          .from(agentRuns)
          .where(and(...conditions));

        // Load spend cap setting for this company
        const capSetting = await db.query.companySettings.findFirst({
          where: and(
            eq(companySettings.companyId, companyId),
            eq(companySettings.key, "spend_cap_usd"),
          ),
        });
        const spendCapUsd = capSetting?.value ? parseFloat(String(capSetting.value)) : null;

        res.json({
          totalRuns: summary?.totalRuns ?? 0,
          totalTokensInput: summary?.totalTokensInput ?? 0,
          totalTokensOutput: summary?.totalTokensOutput ?? 0,
          totalCostUsd: parseFloat(summary?.totalCostUsd ?? "0"),
          spendCapUsd: isNaN(spendCapUsd as number) ? null : spendCapUsd,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/usage/by-agent — usage breakdown per agent
  router.get(
    "/by-agent",
    authenticate(),
    requirePermission("agent:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const { from, to } = parseDateRange(req);
        const companyId = req.companyId!;

        const conditions = [eq(agentRuns.companyId, companyId)];
        if (from) conditions.push(gte(agentRuns.startedAt, from));
        if (to) conditions.push(lte(agentRuns.startedAt, to));

        const rows = await db
          .select({
            agentId: agentRuns.agentId,
            agentName: agents.name,
            runCount: sql<number>`count(*)::int`,
            tokensInput: sql<number>`coalesce(sum(${agentRuns.tokensInput}), 0)::int`,
            tokensOutput: sql<number>`coalesce(sum(${agentRuns.tokensOutput}), 0)::int`,
            costUsd: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)::text`,
            avgDurationMs: sql<number>`coalesce(avg(${agentRuns.durationMs}), 0)::int`,
          })
          .from(agentRuns)
          .leftJoin(agents, eq(agentRuns.agentId, agents.id))
          .where(and(...conditions))
          .groupBy(agentRuns.agentId, agents.name)
          .orderBy(sql`sum(${agentRuns.costUsd}) desc nulls last`);

        res.json(
          rows.map((r) => ({
            ...r,
            costUsd: parseFloat(r.costUsd ?? "0"),
          })),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/usage/daily — daily cost breakdown (for chart)
  router.get(
    "/daily",
    authenticate(),
    requirePermission("company:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const { from, to } = parseDateRange(req);
        const companyId = req.companyId!;
        const agentId = req.query.agentId as string | undefined;

        const conditions = [eq(agentRuns.companyId, companyId)];
        if (from) conditions.push(gte(agentRuns.startedAt, from));
        if (to) conditions.push(lte(agentRuns.startedAt, to));
        if (agentId) conditions.push(eq(agentRuns.agentId, agentId));

        const rows = await db
          .select({
            date: sql<string>`date_trunc('day', ${agentRuns.startedAt})::date::text`,
            runCount: sql<number>`count(*)::int`,
            costUsd: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)::text`,
          })
          .from(agentRuns)
          .where(and(...conditions))
          .groupBy(sql`date_trunc('day', ${agentRuns.startedAt})`)
          .orderBy(sql`date_trunc('day', ${agentRuns.startedAt})`);

        res.json(
          rows.map((r) => ({
            date: r.date,
            runCount: r.runCount,
            costUsd: parseFloat(r.costUsd ?? "0"),
          })),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/usage/by-company — super-admin only: usage breakdown per company
  router.get(
    "/by-company",
    authenticate(),
    async (req, res, next) => {
      try {
        if (!req.auth?.super_admin) {
          // Non-super-admins only see their own company
          return res.redirect(307, "/api/usage/summary");
        }

        const db = getDb();
        const { from, to } = parseDateRange(req);

        const conditions = [];
        if (from) conditions.push(gte(agentRuns.startedAt, from));
        if (to) conditions.push(lte(agentRuns.startedAt, to));

        const rows = await db
          .select({
            companyId: agentRuns.companyId,
            companyName: companies.name,
            companyDisplayName: companies.displayName,
            runCount: sql<number>`count(*)::int`,
            tokensInput: sql<number>`coalesce(sum(${agentRuns.tokensInput}), 0)::int`,
            tokensOutput: sql<number>`coalesce(sum(${agentRuns.tokensOutput}), 0)::int`,
            costUsd: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)::text`,
          })
          .from(agentRuns)
          .leftJoin(companies, eq(agentRuns.companyId, companies.id))
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .groupBy(agentRuns.companyId, companies.name, companies.displayName)
          .orderBy(sql`sum(${agentRuns.costUsd}) desc nulls last`);

        res.json(
          rows.map((r) => ({
            ...r,
            costUsd: parseFloat(r.costUsd ?? "0"),
          })),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ================================================================
// Exported helper for M6.4 execution engine: spend cap check
// ================================================================

/**
 * Check if running a new agent run would exceed the company's spend cap.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 * Cap is stored in company_settings as key "spend_cap_usd".
 */
export async function checkSpendCap(
  companyId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const db = getDb();

  // Load spend cap from company settings
  const { companySettings } = await import("@agentops/db");
  const capSetting = await db.query.companySettings.findFirst({
    where: and(
      eq(companySettings.companyId, companyId),
      eq(companySettings.key, "spend_cap_usd"),
    ),
  });

  if (!capSetting || capSetting.value === null) {
    return { allowed: true }; // No cap set
  }

  const cap = parseFloat(String(capSetting.value));
  if (isNaN(cap) || cap <= 0) return { allowed: true };

  // Sum current month spend
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [usage] = await db
    .select({ total: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)::text` })
    .from(agentRuns)
    .where(and(eq(agentRuns.companyId, companyId), gte(agentRuns.startedAt, monthStart)));

  const current = parseFloat(usage?.total ?? "0");
  if (current >= cap) {
    return {
      allowed: false,
      reason: `Monthly spend cap of $${cap.toFixed(2)} exceeded (current: $${current.toFixed(2)})`,
    };
  }

  return { allowed: true };
}
