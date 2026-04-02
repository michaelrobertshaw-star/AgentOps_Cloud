/**
 * Tenant branding routes
 *
 * GET  /api/tenant/branding — return branding config for the authenticated company
 * PUT  /api/tenant/branding — update branding config (admin only)
 */

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { companies } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError } from "../lib/errors.js";

export interface BrandingConfig {
  primaryColor?: string;
  logoUrl?: string;
  companyName?: string;
}

const updateBrandingSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Must be a valid hex color (e.g. #1E40AF)").optional(),
  logoUrl: z.string().url().optional().nullable(),
  companyName: z.string().max(100).optional(),
});

export function tenantRoutes() {
  const router = Router();

  // GET /api/tenant/branding
  router.get("/branding", authenticate(), async (req, res, next) => {
    try {
      const db = getDb();
      const company = await db.query.companies.findFirst({
        where: eq(companies.id, req.companyId!),
      });
      if (!company) throw new NotFoundError("Company");

      const settings = (company.settings ?? {}) as Record<string, unknown>;
      const branding = (settings.branding ?? {}) as BrandingConfig;

      res.json({
        primaryColor: branding.primaryColor ?? null,
        logoUrl: branding.logoUrl ?? null,
        companyName: branding.companyName ?? company.displayName,
      });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/tenant/branding — update branding (admin only)
  router.put(
    "/branding",
    authenticate(),
    requirePermission("company:manage"),
    validate(updateBrandingSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const company = await db.query.companies.findFirst({
          where: eq(companies.id, req.companyId!),
        });
        if (!company) throw new NotFoundError("Company");

        const { primaryColor, logoUrl, companyName } = req.body as z.infer<typeof updateBrandingSchema>;
        const settings = (company.settings ?? {}) as Record<string, unknown>;
        const existingBranding = (settings.branding ?? {}) as BrandingConfig;

        const newBranding: BrandingConfig = {
          ...existingBranding,
          ...(primaryColor !== undefined && { primaryColor }),
          ...(logoUrl !== undefined && { logoUrl: logoUrl ?? undefined }),
          ...(companyName !== undefined && { companyName }),
        };

        await db
          .update(companies)
          .set({
            settings: { ...settings, branding: newBranding },
            updatedAt: new Date(),
          })
          .where(eq(companies.id, req.companyId!));

        res.json(newBranding);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
