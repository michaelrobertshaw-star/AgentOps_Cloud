/**
 * M6.1 — Company Onboarding Wizard (Admin Routes)
 *
 * Platform-level super-admin routes for managing tenants.
 * All routes require oneops_admin role or super_admin: true in the JWT.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { companies, users, connectors, companySettings } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { hashPassword } from "../services/authService.js";
import { sendUserInviteEmail } from "../services/emailService.js";
import { ForbiddenError, NotFoundError, ConflictError } from "../lib/errors.js";
import type { Request, Response, NextFunction } from "express";

// ================================================================
// Super-admin auth middleware
// ================================================================

function requireSuperAdmin() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const isOneopsAdmin = req.auth?.roles?.includes("oneops_admin");
    const isSuperAdmin = req.auth?.super_admin;
    if (!isOneopsAdmin && !isSuperAdmin) {
      return next(new ForbiddenError("Platform admin access required"));
    }
    next();
  };
}

// ================================================================
// Encryption helpers (reuse connector pattern)
// ================================================================

const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const raw = process.env.CONNECTOR_ENCRYPTION_KEY ?? "";
  if (raw.length === 64) return Buffer.from(raw, "hex");
  if (process.env.NODE_ENV === "production") {
    throw new Error("FATAL: CONNECTOR_ENCRYPTION_KEY must be a 64-char hex string in production.");
  }
  console.warn("[SECURITY] CONNECTOR_ENCRYPTION_KEY not set — using weak fallback. NOT safe for production.");
  const padded = raw.padEnd(64, "0").slice(0, 64);
  return Buffer.from(padded, "hex");
}

function encryptSecrets(secrets: Record<string, string>): { iv: string; tag: string; ciphertext: string } {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const json = JSON.stringify(secrets);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: encrypted.toString("hex"),
  };
}

function decryptSecrets(payload: { iv: string; tag: string; ciphertext: string }): Record<string, string> {
  const key = getEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "hex"));
  decipher.setAuthTag(Buffer.from(payload.tag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "hex")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

function maskSecrets(secrets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(secrets).map(([k, v]) => [k, v.length > 4 ? `${"*".repeat(v.length - 4)}${v.slice(-4)}` : "****"]),
  );
}

// ================================================================
// Validation schemas
// ================================================================

const createCompanySchema = z.object({
  name: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/, "Lowercase letters, digits, hyphens only"),
  displayName: z.string().min(2).max(255),
  timezone: z.string().max(50).optional().default("UTC"),
  region: z.string().max(50).optional(),
});

const updateSettingsSchema = z.object({
  // Key/value pairs to upsert into company_settings
  settings: z.record(z.unknown()),
});

const inviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  role: z.enum(["oneops_admin", "customer_admin", "customer_user"]).default("customer_user"),
  password: z.string().min(8),
});

const connectorTypeEnum = z.enum(["claude_api", "claude_browser", "webhook", "http_get", "minio_storage"]);

const createConnectorAdminSchema = z.object({
  type: connectorTypeEnum,
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  config: z.record(z.unknown()).optional().default({}),
  secrets: z.record(z.string()).optional().default({}),
  isDefault: z.boolean().optional().default(false),
});

const updateConnectorAdminSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  config: z.record(z.unknown()).optional(),
  secrets: z.record(z.string()).optional(),
  isDefault: z.boolean().optional(),
});

// ================================================================
// Routes
// ================================================================

export function adminCompanyRoutes() {
  const router = Router();

  // GET /api/admin/companies — list all tenants
  router.get(
    "/",
    authenticate(),
    requireSuperAdmin(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const rows = await db.query.companies.findMany({
          orderBy: (c, { desc: d }) => [d(c.createdAt)],
        });
        res.json(rows);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/admin/companies — create new tenant
  router.post(
    "/",
    authenticate(),
    requireSuperAdmin(),
    validate(createCompanySchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const { name, displayName, timezone, region } = req.body as z.infer<typeof createCompanySchema>;

        // Check uniqueness
        const existing = await db.query.companies.findFirst({
          where: eq(companies.name, name),
        });
        if (existing) {
          throw new ConflictError(`Company name '${name}' is already taken`);
        }

        const [company] = await db
          .insert(companies)
          .values({ name, displayName, timezone: timezone ?? "UTC", region })
          .returning();

        // Seed default claude_api connector if ANTHROPIC_API_KEY is configured
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (anthropicKey) {
          const encrypted = encryptSecrets({ apiKey: anthropicKey });
          await db.insert(connectors).values({
            companyId: company.id,
            type: "claude_api",
            name: "Default Claude API",
            description: "Auto-seeded from ANTHROPIC_API_KEY",
            config: { model: "claude-sonnet-4-6" },
            secretsEncrypted: encrypted,
            isDefault: true,
          });
        }

        res.status(201).json(company);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/admin/companies/:id — get a single company
  router.get(
    "/:id",
    authenticate(),
    requireSuperAdmin(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const company = await db.query.companies.findFirst({
          where: eq(companies.id, req.params.id as string),
        });
        if (!company) throw new NotFoundError("Company");

        // Load settings
        const settingsRows = await db.query.companySettings.findMany({
          where: eq(companySettings.companyId, company.id),
        });
        const settingsMap: Record<string, unknown> = {};
        for (const s of settingsRows) {
          settingsMap[s.key] = s.value;
        }

        res.json({ ...company, companySettings: settingsMap });
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH /api/admin/companies/:id/settings — upsert key/value settings
  router.patch(
    "/:id/settings",
    authenticate(),
    requireSuperAdmin(),
    validate(updateSettingsSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.params.id as string;

        const company = await db.query.companies.findFirst({
          where: eq(companies.id, companyId),
        });
        if (!company) throw new NotFoundError("Company");

        const { settings } = req.body as z.infer<typeof updateSettingsSchema>;

        // Upsert each key
        for (const [key, value] of Object.entries(settings)) {
          await db
            .insert(companySettings)
            .values({ companyId, key, value: value ?? null })
            .onConflictDoUpdate({
              target: [companySettings.companyId, companySettings.key],
              set: { value: value ?? null, updatedAt: new Date() },
            });
        }

        const updated = await db.query.companySettings.findMany({
          where: eq(companySettings.companyId, companyId),
        });
        const settingsMap: Record<string, unknown> = {};
        for (const s of updated) {
          settingsMap[s.key] = s.value;
        }

        res.json(settingsMap);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/admin/companies/:id/users — list users for a company
  router.get(
    "/:id/users",
    authenticate(),
    requireSuperAdmin(),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.params.id as string;

        const company = await db.query.companies.findFirst({
          where: eq(companies.id, companyId),
        });
        if (!company) throw new NotFoundError("Company");

        const rows = await db.query.users.findMany({
          where: eq(users.companyId, companyId),
          orderBy: (u, { asc }) => [asc(u.name)],
        });

        // Never return password hashes
        res.json(rows.map(({ passwordHash: _ph, mfaSecret: _ms, ...u }) => u));
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/admin/companies/:id/users — invite user to company
  router.post(
    "/:id/users",
    authenticate(),
    requireSuperAdmin(),
    validate(inviteUserSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.params.id as string;

        const company = await db.query.companies.findFirst({
          where: eq(companies.id, companyId),
        });
        if (!company) throw new NotFoundError("Company");

        const { email, name, role, password } = req.body as z.infer<typeof inviteUserSchema>;

        // Check uniqueness within company
        const existing = await db.query.users.findFirst({
          where: eq(users.email, email),
        });
        if (existing) throw new ConflictError("Email already registered");

        const passwordHash = await hashPassword(password);
        const [user] = await db
          .insert(users)
          .values({ companyId, email, name, role, passwordHash, status: "active" })
          .returning();

        const { passwordHash: _ph, mfaSecret: _ms, ...safe } = user;

        // Fire invite email (non-blocking — don't fail the request if email delivery fails)
        sendUserInviteEmail({
          toEmail: email,
          toName: name,
          companyName: company.displayName ?? company.name,
        }).catch((err) => {
          console.error("[adminCompanies] Failed to send invite email:", err);
        });

        // Return loginPassword once so the UI can display it to the admin.
        // This is intentional — admin needs to hand credentials to the new user.
        res.status(201).json({ ...safe, loginPassword: password });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Connector management (admin-scoped) ────────────────────────────────────

  // GET /api/admin/companies/:id/connectors
  router.get("/:id/connectors", authenticate(), requireSuperAdmin(), async (req, res, next) => {
    try {
      const db = getDb();
      const companyId = req.params.id as string;
      const rows = await db.query.connectors.findMany({
        where: eq(connectors.companyId, companyId),
        orderBy: (c, { asc }) => [asc(c.name)],
      });
      res.json(
        rows.map((c) => ({
          ...c,
          secretsEncrypted: undefined,
          secrets: c.secretsEncrypted ? maskSecrets(decryptSecrets(c.secretsEncrypted as { iv: string; tag: string; ciphertext: string })) : {},
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/companies/:id/connectors
  router.post(
    "/:id/connectors",
    authenticate(),
    requireSuperAdmin(),
    validate(createConnectorAdminSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.params.id as string;
        const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
        if (!company) throw new NotFoundError("Company");

        const { type, name, description, config, secrets, isDefault } = req.body as z.infer<typeof createConnectorAdminSchema>;
        const secretsEncrypted = Object.keys(secrets).length > 0 ? encryptSecrets(secrets) : null;

        const [connector] = await db
          .insert(connectors)
          .values({ companyId, type, name, description, config, secretsEncrypted, isDefault })
          .returning();

        res.status(201).json({ ...connector, secretsEncrypted: undefined, secrets: secrets ? maskSecrets(secrets) : {} });
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH /api/admin/companies/:id/connectors/:connectorId
  router.patch(
    "/:id/connectors/:connectorId",
    authenticate(),
    requireSuperAdmin(),
    validate(updateConnectorAdminSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const companyId = req.params.id as string;
        const connectorId = req.params.connectorId as string;

        const existing = await db.query.connectors.findFirst({
          where: and(eq(connectors.id, connectorId), eq(connectors.companyId, companyId)),
        });
        if (!existing) throw new NotFoundError("Connector");

        const { name, description, config, secrets, isDefault } = req.body as z.infer<typeof updateConnectorAdminSchema>;
        let secretsEncrypted = existing.secretsEncrypted;
        if (secrets !== undefined) {
          secretsEncrypted = Object.keys(secrets).length > 0 ? encryptSecrets(secrets) : null;
        }

        const [updated] = await db
          .update(connectors)
          .set({
            ...(name !== undefined && { name }),
            ...(description !== undefined && { description }),
            ...(config !== undefined && { config }),
            ...(isDefault !== undefined && { isDefault }),
            secretsEncrypted,
            updatedAt: new Date(),
          })
          .where(and(eq(connectors.id, connectorId), eq(connectors.companyId, companyId)))
          .returning();

        const decrypted = updated.secretsEncrypted ? decryptSecrets(updated.secretsEncrypted as { iv: string; tag: string; ciphertext: string }) : {};
        res.json({ ...updated, secretsEncrypted: undefined, secrets: maskSecrets(decrypted) });
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/admin/companies/:id/connectors/:connectorId
  router.delete("/:id/connectors/:connectorId", authenticate(), requireSuperAdmin(), async (req, res, next) => {
    try {
      const db = getDb();
      const companyId = req.params.id as string;
      const connectorId = req.params.connectorId as string;

      const existing = await db.query.connectors.findFirst({
        where: and(eq(connectors.id, connectorId), eq(connectors.companyId, companyId)),
      });
      if (!existing) throw new NotFoundError("Connector");

      await db.delete(connectors).where(and(eq(connectors.id, connectorId), eq(connectors.companyId, companyId)));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
