import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { auditLogs } from "@agentops/db";
import type { AuditActorType, AuditOutcome, AuditRiskLevel } from "@agentops/shared";
import { getDb } from "../lib/db.js";

// In-memory last hash for hash chain (in production, fetch from DB)
let lastHash = "0".repeat(64);

export interface AuditEntry {
  companyId: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  departmentId?: string;
  context?: Record<string, unknown>;
  changes?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
  outcome?: AuditOutcome;
  riskLevel?: AuditRiskLevel;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  const db = getDb();

  // Build hash chain
  const entryData = JSON.stringify({
    ...entry,
    timestamp: new Date().toISOString(),
  });
  const entryHash = crypto
    .createHash("sha256")
    .update(lastHash + entryData)
    .digest("hex");
  lastHash = entryHash;

  await db.insert(auditLogs).values({
    companyId: entry.companyId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    departmentId: entry.departmentId,
    context: entry.context ?? {},
    changes: entry.changes,
    outcome: entry.outcome ?? "success",
    riskLevel: entry.riskLevel ?? "low",
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    requestId: entry.requestId,
    entryHash,
  });
}

export async function queryAuditLogs(
  companyId: string,
  options: {
    limit?: number;
    cursor?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
  } = {},
) {
  const db = getDb();
  const limit = options.limit ?? 50;

  const rows = await db.query.auditLogs.findMany({
    where: eq(auditLogs.companyId, companyId),
    orderBy: [desc(auditLogs.createdAt)],
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1].id : undefined;

  return { items, nextCursor };
}
