import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { webhooks, webhookDeliveries } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ForbiddenError } from "../lib/errors.js";
import { attemptDelivery, buildSignature, SUPPORTED_EVENTS } from "../services/webhookService.js";

const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.string().min(1)).min(1),
  secret: z.string().min(16).max(255).optional(), // auto-generated if omitted
});

const updateWebhookSchema = z.object({
  url: z.string().url().max(2048).optional(),
  events: z.array(z.string().min(1)).min(1).optional(),
  status: z.enum(["active", "paused"]).optional(),
});

// ================================================================
// Company-scoped routes: /api/companies/:companyId/webhooks
// ================================================================
export function webhookCompanyRoutes() {
  const router = Router({ mergeParams: true });

  // POST /api/companies/:companyId/webhooks
  router.post(
    "/",
    authenticate(),
    requirePermission("company:manage"),
    validate(createWebhookSchema),
    async (req, res, next) => {
      try {
        // Only allow acting on own company
        if (req.params.companyId !== req.companyId) {
          throw new ForbiddenError("Cannot create webhooks for another company");
        }

        const db = getDb();
        const secret = req.body.secret ?? randomBytes(32).toString("hex");

        const [webhook] = await db
          .insert(webhooks)
          .values({
            companyId: req.companyId!,
            url: req.body.url,
            events: req.body.events,
            secret,
            status: "active",
          })
          .returning();

        await req.audit?.({
          action: "webhook:create",
          resourceType: "webhook",
          resourceId: webhook.id,
          riskLevel: "medium",
        });

        // Return webhook but mask the secret (show once)
        res.status(201).json({ ...webhook, secret });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/companies/:companyId/webhooks
  router.get(
    "/",
    authenticate(),
    requirePermission("company:manage"),
    async (req, res, next) => {
      try {
        if (req.params.companyId !== req.companyId) {
          throw new ForbiddenError("Cannot list webhooks for another company");
        }

        const db = getDb();
        const all = await db.query.webhooks.findMany({
          where: eq(webhooks.companyId, req.companyId!),
        });

        // Mask secrets in list
        res.json(all.map((w) => ({ ...w, secret: "***" })));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ================================================================
// Global webhook routes: /api/webhooks
// ================================================================
export function webhookRoutes() {
  const router = Router();

  // PATCH /api/webhooks/:id
  router.patch(
    "/:id",
    authenticate(),
    requirePermission("company:manage"),
    validate(updateWebhookSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const webhook = await db.query.webhooks.findFirst({
          where: and(eq(webhooks.id, id), eq(webhooks.companyId, req.companyId!)),
        });
        if (!webhook) throw new NotFoundError("Webhook", id);

        const [updated] = await db
          .update(webhooks)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(webhooks.id, id), eq(webhooks.companyId, req.companyId!)))
          .returning();

        await req.audit?.({
          action: "webhook:update",
          resourceType: "webhook",
          resourceId: id,
          riskLevel: "low",
        });

        res.json({ ...updated, secret: "***" });
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/webhooks/:id
  router.delete(
    "/:id",
    authenticate(),
    requirePermission("company:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const webhook = await db.query.webhooks.findFirst({
          where: and(eq(webhooks.id, id), eq(webhooks.companyId, req.companyId!)),
        });
        if (!webhook) throw new NotFoundError("Webhook", id);

        await db.delete(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.companyId, req.companyId!)));

        await req.audit?.({
          action: "webhook:delete",
          resourceType: "webhook",
          resourceId: id,
          riskLevel: "high",
        });

        res.json({ message: "Webhook deleted" });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/webhooks/:id/test — send test ping
  router.post(
    "/:id/test",
    authenticate(),
    requirePermission("company:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const webhook = await db.query.webhooks.findFirst({
          where: and(eq(webhooks.id, id), eq(webhooks.companyId, req.companyId!)),
        });
        if (!webhook) throw new NotFoundError("Webhook", id);

        const payload = {
          event: "test.ping",
          webhookId: id,
          companyId: req.companyId!,
          timestamp: new Date().toISOString(),
        };

        const result = await attemptDelivery(webhook.url, webhook.secret, "test.ping", payload, 1);

        // Log the delivery
        const [delivery] = await db
          .insert(webhookDeliveries)
          .values({
            companyId: req.companyId!,
            webhookId: id,
            eventType: "test.ping",
            payload,
            statusCode: result.statusCode,
            responseBody: result.responseBody,
            attemptNumber: 1,
            success: result.success,
            errorMessage: result.errorMessage,
            durationMs: result.durationMs,
          })
          .returning();

        // Compute what the signature was for the client to verify
        const body = JSON.stringify(payload);
        const signature = buildSignature(webhook.secret, body);

        res.json({
          success: result.success,
          statusCode: result.statusCode,
          durationMs: result.durationMs,
          signature,
          delivery,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/webhooks/:id/deliveries
  router.get(
    "/:id/deliveries",
    authenticate(),
    requirePermission("company:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;

        const webhook = await db.query.webhooks.findFirst({
          where: and(eq(webhooks.id, id), eq(webhooks.companyId, req.companyId!)),
        });
        if (!webhook) throw new NotFoundError("Webhook", id);

        const deliveries = await db.query.webhookDeliveries.findMany({
          where: eq(webhookDeliveries.webhookId, id),
        });

        res.json(deliveries);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
