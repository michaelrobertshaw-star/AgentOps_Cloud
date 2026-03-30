import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import { agents, agentApiKeys } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ConflictError } from "../lib/errors.js";

const createKeySchema = z.object({
  name: z.string().min(1).max(100).default("default"),
  expiresAt: z.string().datetime().optional(),
});

/**
 * Generate a random API key with a recognizable prefix.
 * Format: "ak_<32 hex chars>" (prefix "ak_" for identification, 32 hex = 128 bits)
 */
function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const randomBytes = crypto.randomBytes(32);
  const raw = `ak_${randomBytes.toString("hex")}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 10); // "ak_" + first 7 hex chars
  return { raw, hash, prefix };
}

/**
 * Verify a raw API key against a stored hash.
 */
export function verifyApiKey(raw: string, hash: string): boolean {
  const computedHash = crypto.createHash("sha256").update(raw).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(hash));
}

export function agentKeyRoutes() {
  const router = Router({ mergeParams: true });

  // GET /agents/:agentId/keys — list API keys for an agent (keys are masked)
  router.get("/", authenticate(), requirePermission("apikey:manage"), async (req, res, next) => {
    try {
      const db = getDb();
      const agentId = req.params.agentId as string;

      // Verify agent belongs to company
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, agentId), eq(agents.companyId, req.companyId!)),
      });
      if (!agent) {
        throw new NotFoundError("Agent", agentId);
      }

      const keys = await db.query.agentApiKeys.findMany({
        where: and(
          eq(agentApiKeys.agentId, agentId),
          eq(agentApiKeys.companyId, req.companyId!),
        ),
      });

      // Never expose keyHash to clients
      const masked = keys.map(({ keyHash, ...rest }) => rest);
      res.json(masked);
    } catch (err) {
      next(err);
    }
  });

  // POST /agents/:agentId/keys — create a new API key
  router.post(
    "/",
    authenticate(),
    requirePermission("apikey:manage"),
    validate(createKeySchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const agentId = req.params.agentId as string;

        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, req.companyId!)),
        });
        if (!agent) {
          throw new NotFoundError("Agent", agentId);
        }

        const { raw, hash, prefix } = generateApiKey();

        const [key] = await db
          .insert(agentApiKeys)
          .values({
            companyId: req.companyId!,
            agentId,
            keyHash: hash,
            keyPrefix: prefix,
            name: req.body.name,
            expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : undefined,
          })
          .returning();

        await req.audit?.({
          action: "apikey:create",
          resourceType: "agent_api_key",
          resourceId: key.id,
          departmentId: agent.departmentId ?? undefined,
          riskLevel: "high",
        });

        // Return the raw key ONLY on creation — it can never be retrieved again
        const { keyHash, ...safeKey } = key;
        res.status(201).json({ ...safeKey, key: raw });
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /agents/:agentId/keys/:keyId — revoke an API key
  router.delete(
    "/:keyId",
    authenticate(),
    requirePermission("apikey:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const agentId = req.params.agentId as string;
        const keyId = req.params.keyId as string;

        const key = await db.query.agentApiKeys.findFirst({
          where: and(
            eq(agentApiKeys.id, keyId),
            eq(agentApiKeys.agentId, agentId),
            eq(agentApiKeys.companyId, req.companyId!),
          ),
        });
        if (!key) {
          throw new NotFoundError("API key", keyId);
        }
        if (key.status === "revoked") {
          throw new ConflictError("API key is already revoked");
        }

        const [updated] = await db
          .update(agentApiKeys)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(eq(agentApiKeys.id, keyId))
          .returning();

        await req.audit?.({
          action: "apikey:revoke",
          resourceType: "agent_api_key",
          resourceId: updated.id,
          riskLevel: "high",
        });

        const { keyHash, ...safeKey } = updated;
        res.json({ message: "API key revoked", key: safeKey });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /agents/:agentId/keys/:keyId/rotate — revoke old key and issue new one
  router.post(
    "/:keyId/rotate",
    authenticate(),
    requirePermission("apikey:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const agentId = req.params.agentId as string;
        const keyId = req.params.keyId as string;

        const oldKey = await db.query.agentApiKeys.findFirst({
          where: and(
            eq(agentApiKeys.id, keyId),
            eq(agentApiKeys.agentId, agentId),
            eq(agentApiKeys.companyId, req.companyId!),
          ),
        });
        if (!oldKey) {
          throw new NotFoundError("API key", keyId);
        }
        if (oldKey.status !== "active") {
          throw new ConflictError("Can only rotate active keys");
        }

        // Revoke old key
        await db
          .update(agentApiKeys)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(eq(agentApiKeys.id, keyId));

        // Create new key
        const { raw, hash, prefix } = generateApiKey();
        const [newKey] = await db
          .insert(agentApiKeys)
          .values({
            companyId: req.companyId!,
            agentId,
            keyHash: hash,
            keyPrefix: prefix,
            name: oldKey.name,
            expiresAt: oldKey.expiresAt,
          })
          .returning();

        await req.audit?.({
          action: "apikey:rotate",
          resourceType: "agent_api_key",
          resourceId: newKey.id,
          changes: { before: { keyId: oldKey.id }, after: { keyId: newKey.id } },
          riskLevel: "high",
        });

        const { keyHash, ...safeKey } = newKey;
        res.status(201).json({ ...safeKey, key: raw, revokedKeyId: oldKey.id });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
