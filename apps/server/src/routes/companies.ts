import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { companies } from "@agentops/db";
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
