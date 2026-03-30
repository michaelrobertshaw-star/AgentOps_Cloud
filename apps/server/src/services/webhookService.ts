import { createHmac } from "node:crypto";
import { webhooks, webhookDeliveries } from "@agentops/db";
import { eq, and } from "drizzle-orm";
import { getDb } from "../lib/db.js";

export const SUPPORTED_EVENTS = [
  "task.completed",
  "task.failed",
  "task.created",
  "incident.created",
  "incident.resolved",
  "incident.closed",
  "agent.degraded",
  "agent.stopped",
  "workspace.file_uploaded",
  "workspace.file_deleted",
] as const;

export type WebhookEvent = (typeof SUPPORTED_EVENTS)[number];

/**
 * Build the HMAC-SHA256 signature for a webhook payload.
 * Returns the value for the `X-Paperclip-Signature` header.
 */
export function buildSignature(secret: string, body: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Attempt a single HTTP delivery to a webhook endpoint.
 * Returns { success, statusCode, responseBody, durationMs, errorMessage }.
 */
export async function attemptDelivery(
  url: string,
  secret: string,
  eventType: string,
  payload: Record<string, unknown>,
  attemptNumber: number,
): Promise<{
  success: boolean;
  statusCode: number | null;
  responseBody: string | null;
  durationMs: number;
  errorMessage: string | null;
}> {
  const body = JSON.stringify(payload);
  const signature = buildSignature(secret, body);
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Paperclip-Signature": signature,
        "X-Paperclip-Event": eventType,
        "X-Paperclip-Attempt": String(attemptNumber),
      },
      body,
      signal: AbortSignal.timeout(10_000), // 10 second timeout
    });

    const durationMs = Date.now() - start;
    let responseBody: string | null = null;
    try {
      responseBody = await response.text();
    } catch {
      // ignore
    }
    const success = response.status >= 200 && response.status < 300;
    return { success, statusCode: response.status, responseBody, durationMs, errorMessage: null };
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      success: false,
      statusCode: null,
      responseBody: null,
      durationMs,
      errorMessage: (err as Error).message,
    };
  }
}

/**
 * Deliver a webhook event to all active subscribed webhooks for a company.
 * Logs each delivery attempt to webhook_deliveries.
 *
 * Note: In production, delivery retries should be queued via BullMQ.
 * This synchronous implementation is used for the test ping endpoint and
 * simple event dispatch.
 */
export async function deliverWebhookEvent(
  companyId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  const activeWebhooks = await db.query.webhooks.findMany({
    where: and(eq(webhooks.companyId, companyId), eq(webhooks.status, "active")),
  });

  const subscribedWebhooks = activeWebhooks.filter(
    (wh) => wh.events.includes(eventType) || wh.events.includes("*"),
  );

  for (const webhook of subscribedWebhooks) {
    const MAX_ATTEMPTS = 3;
    let lastResult = {
      success: false,
      statusCode: null as number | null,
      responseBody: null as string | null,
      durationMs: 0,
      errorMessage: null as string | null,
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        // Exponential backoff: 1s, 2s, 4s
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 2)));
      }

      lastResult = await attemptDelivery(
        webhook.url,
        webhook.secret,
        eventType,
        payload,
        attempt,
      );

      await db.insert(webhookDeliveries).values({
        companyId,
        webhookId: webhook.id,
        eventType,
        payload,
        statusCode: lastResult.statusCode,
        responseBody: lastResult.responseBody,
        attemptNumber: attempt,
        success: lastResult.success,
        errorMessage: lastResult.errorMessage,
        durationMs: lastResult.durationMs,
      });

      if (lastResult.success) break;
    }

    // Update webhook failure count if all attempts failed
    if (!lastResult.success) {
      await db
        .update(webhooks)
        .set({
          failureCount: webhook.failureCount + 1,
          status: webhook.failureCount + 1 >= 5 ? "failed" : webhook.status,
          updatedAt: new Date(),
        })
        .where(eq(webhooks.id, webhook.id));
    } else {
      await db
        .update(webhooks)
        .set({ lastTriggeredAt: new Date(), updatedAt: new Date() })
        .where(eq(webhooks.id, webhook.id));
    }
  }
}
