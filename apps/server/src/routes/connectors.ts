/**
 * M6.3 — Connector Registry
 *
 * Routes for managing connectors (claude_api, claude_browser, webhook,
 * http_get, minio_storage) and attaching them to agents.
 *
 * Secrets are encrypted at rest using AES-256-GCM.
 * The encryption key is read from CONNECTOR_ENCRYPTION_KEY env var (32-byte hex).
 */

import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { connectors, agentConnectors, agents } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ForbiddenError, ValidationError } from "../lib/errors.js";

// ================================================================
// Encryption helpers
// ================================================================

const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const raw = process.env.CONNECTOR_ENCRYPTION_KEY ?? "";
  if (raw.length === 64) {
    // 32 bytes as hex string
    return Buffer.from(raw, "hex");
  }
  // Fallback: derive 32 bytes from whatever is provided (development only).
  // In production, CONNECTOR_ENCRYPTION_KEY must be a 64-char hex string.
  const padded = raw.padEnd(64, "0").slice(0, 64);
  return Buffer.from(padded, "hex");
}

interface EncryptedPayload {
  iv: string;
  tag: string;
  ciphertext: string;
}

function encryptSecrets(plaintext: Record<string, string>): EncryptedPayload {
  const key = getEncryptionKey();
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const json = JSON.stringify(plaintext);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: encrypted.toString("hex"),
  };
}

function decryptSecrets(payload: EncryptedPayload): Record<string, string> {
  const key = getEncryptionKey();
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(payload.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "hex")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

/** Return secrets masked (show only last 4 chars of each value). */
function maskSecrets(secrets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(secrets).map(([k, v]) => [
      k,
      v.length > 4 ? `${"*".repeat(v.length - 4)}${v.slice(-4)}` : "****",
    ]),
  );
}

// ================================================================
// Validation schemas
// ================================================================

const connectorTypeEnum = z.enum([
  "claude_api",
  "claude_browser",
  "webhook",
  "http_get",
  "minio_storage",
]);

const createConnectorSchema = z.object({
  type: connectorTypeEnum,
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  config: z.record(z.unknown()).optional().default({}),
  // Plaintext secrets — encrypted before storage
  secrets: z.record(z.string()).optional().default({}),
  isDefault: z.boolean().optional().default(false),
});

const updateConnectorSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  config: z.record(z.unknown()).optional(),
  secrets: z.record(z.string()).optional(),
  isDefault: z.boolean().optional(),
});

// ================================================================
// Connector routes: /api/connectors
// ================================================================

export function connectorRoutes() {
  const router = Router();

  // GET /api/connectors — list connectors for the authenticated company
  router.get("/", authenticate(), requirePermission("connector:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const rows = await db.query.connectors.findMany({
        where: eq(connectors.companyId, req.companyId!),
        orderBy: (c, { asc }) => [asc(c.name)],
      });

      // Return connectors with masked secrets
      const result = rows.map((c) => ({
        ...c,
        secretsEncrypted: undefined,
        secrets: c.secretsEncrypted
          ? maskSecrets(decryptSecrets(c.secretsEncrypted as EncryptedPayload))
          : {},
      }));

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/connectors — create a connector
  router.post(
    "/",
    authenticate(),
    requirePermission("connector:manage"),
    validate(createConnectorSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const { type, name, description, config, secrets, isDefault } = req.body as z.infer<
          typeof createConnectorSchema
        >;

        const secretsEncrypted =
          Object.keys(secrets).length > 0 ? encryptSecrets(secrets) : null;

        const [connector] = await db
          .insert(connectors)
          .values({
            companyId: req.companyId!,
            type,
            name,
            description,
            config,
            secretsEncrypted,
            isDefault,
            createdByUserId: req.userId ?? null,
          })
          .returning();

        res.status(201).json({
          ...connector,
          secretsEncrypted: undefined,
          secrets: secrets ? maskSecrets(secrets) : {},
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/connectors/:id — get a single connector
  router.get("/:id", authenticate(), requirePermission("connector:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const id = req.params.id as string;
      const connector = await db.query.connectors.findFirst({
        where: and(
          eq(connectors.id, id),
          eq(connectors.companyId, req.companyId!),
        ),
      });

      if (!connector) throw new NotFoundError("Connector");

      const decrypted = connector.secretsEncrypted
        ? decryptSecrets(connector.secretsEncrypted as EncryptedPayload)
        : {};

      res.json({
        ...connector,
        secretsEncrypted: undefined,
        secrets: maskSecrets(decrypted),
      });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/connectors/:id — update a connector
  router.patch(
    "/:id",
    authenticate(),
    requirePermission("connector:manage"),
    validate(updateConnectorSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;
        const existing = await db.query.connectors.findFirst({
          where: and(
            eq(connectors.id, id),
            eq(connectors.companyId, req.companyId!),
          ),
        });

        if (!existing) throw new NotFoundError("Connector");

        const { name, description, config, secrets, isDefault } = req.body as z.infer<
          typeof updateConnectorSchema
        >;

        // If secrets provided, re-encrypt. Otherwise keep existing.
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
          .where(
            and(
              eq(connectors.id, id),
              eq(connectors.companyId, req.companyId!),
            ),
          )
          .returning();

        const decrypted = updated.secretsEncrypted
          ? decryptSecrets(updated.secretsEncrypted as EncryptedPayload)
          : {};

        res.json({
          ...updated,
          secretsEncrypted: undefined,
          secrets: maskSecrets(decrypted),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/connectors/:id — delete a connector
  router.delete(
    "/:id",
    authenticate(),
    requirePermission("connector:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;
        const existing = await db.query.connectors.findFirst({
          where: and(
            eq(connectors.id, id),
            eq(connectors.companyId, req.companyId!),
          ),
        });

        if (!existing) throw new NotFoundError("Connector");

        await db
          .delete(connectors)
          .where(
            and(
              eq(connectors.id, id),
              eq(connectors.companyId, req.companyId!),
            ),
          );

        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ================================================================
// Agent connector routes: /api/agents/:agentId/connectors
// ================================================================

export function agentConnectorRoutes() {
  const router = Router({ mergeParams: true });

  // GET /api/agents/:agentId/connectors — list connectors attached to an agent
  router.get(
    "/",
    authenticate(),
    requirePermission("connector:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const agentId = req.params.agentId as string;

        // Verify agent belongs to this company
        const agent = await db.query.agents.findFirst({
          where: and(
            eq(agents.id, agentId),
            eq(agents.companyId, req.companyId!),
          ),
        });
        if (!agent) throw new NotFoundError("Agent");

        const rows = await db.query.agentConnectors.findMany({
          where: eq(agentConnectors.agentId, agentId),
          with: { connector: true },
        });

        res.json(
          rows.map((r) => ({
            ...r.connector,
            secretsEncrypted: undefined,
            secrets: r.connector.secretsEncrypted
              ? maskSecrets(decryptSecrets(r.connector.secretsEncrypted as EncryptedPayload))
              : {},
          })),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/agents/:agentId/connectors — attach a connector to an agent
  router.post(
    "/",
    authenticate(),
    requirePermission("connector:manage"),
    validate(z.object({ connectorId: z.string().uuid() })),
    async (req, res, next) => {
      try {
        const db = getDb();
        const agentId = req.params.agentId as string;

        const agent = await db.query.agents.findFirst({
          where: and(
            eq(agents.id, agentId),
            eq(agents.companyId, req.companyId!),
          ),
        });
        if (!agent) throw new NotFoundError("Agent");

        const connector = await db.query.connectors.findFirst({
          where: and(
            eq(connectors.id, req.body.connectorId),
            eq(connectors.companyId, req.companyId!),
          ),
        });
        if (!connector) throw new NotFoundError("Connector");

        const [link] = await db
          .insert(agentConnectors)
          .values({
            companyId: req.companyId!,
            agentId,
            connectorId: req.body.connectorId,
          })
          .onConflictDoNothing()
          .returning();

        res.status(201).json(link ?? { message: "Already attached" });
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/agents/:agentId/connectors/:connectorId — detach connector
  router.delete(
    "/:connectorId",
    authenticate(),
    requirePermission("connector:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();

        const agentId = req.params.agentId as string;
        const connectorId = req.params.connectorId as string;

        const agent = await db.query.agents.findFirst({
          where: and(
            eq(agents.id, agentId),
            eq(agents.companyId, req.companyId!),
          ),
        });
        if (!agent) throw new NotFoundError("Agent");

        await db
          .delete(agentConnectors)
          .where(
            and(
              eq(agentConnectors.agentId, agentId),
              eq(agentConnectors.connectorId, connectorId),
            ),
          );

        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ================================================================
// Exported helper for M6.4 execution engine
// ================================================================

/**
 * Load and decrypt connector secrets for a given agent.
 * Used by the execution engine to inject credentials at runtime.
 * Secrets are never logged.
 */
export async function loadAgentConnectorSecrets(
  agentId: string,
  companyId: string,
): Promise<Array<{ connector: typeof connectors.$inferSelect; secrets: Record<string, string> }>> {
  const db = getDb();

  const rows = await db.query.agentConnectors.findMany({
    where: eq(agentConnectors.agentId, agentId),
    with: { connector: true },
  });

  return rows
    .filter((r) => r.connector.companyId === companyId)
    .map((r) => ({
      connector: r.connector,
      secrets: r.connector.secretsEncrypted
        ? decryptSecrets(r.connector.secretsEncrypted as EncryptedPayload)
        : {},
    }));
}
