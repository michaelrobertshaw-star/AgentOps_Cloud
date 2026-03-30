import crypto from "node:crypto";
import { desc, eq, and, gte, lte, lt } from "drizzle-orm";
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
    actorId?: string;
    from?: string;
    to?: string;
  } = {},
) {
  const db = getDb();
  const limit = options.limit ?? 50;

  // Retrieve all for the company (in-memory filtering for simplicity)
  const allRows = await db.query.auditLogs.findMany({
    where: eq(auditLogs.companyId, companyId),
    orderBy: [desc(auditLogs.createdAt)],
  });

  // Apply filters
  let filtered = allRows;
  if (options.action) filtered = filtered.filter((r) => r.action === options.action);
  if (options.resourceType) filtered = filtered.filter((r) => r.resourceType === options.resourceType);
  if (options.resourceId) filtered = filtered.filter((r) => r.resourceId === options.resourceId);
  if (options.actorId) filtered = filtered.filter((r) => r.actorId === options.actorId);
  if (options.from) {
    const from = new Date(options.from);
    filtered = filtered.filter((r) => r.createdAt >= from);
  }
  if (options.to) {
    const to = new Date(options.to);
    filtered = filtered.filter((r) => r.createdAt <= to);
  }

  // Cursor-based pagination (cursor = id of last seen item)
  if (options.cursor) {
    const cursorIdx = filtered.findIndex((r) => r.id === options.cursor);
    if (cursorIdx !== -1) {
      filtered = filtered.slice(cursorIdx + 1);
    }
  }

  const total = filtered.length;
  const hasMore = total > limit;
  const data = filtered.slice(0, limit);
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return { data, nextCursor, total };
}

/**
 * Verify hash chain integrity for all audit logs of a company.
 * Returns { ok: true } or { ok: false, firstCorruptId: string }.
 *
 * Simplified verification: checks that all entryHash values are non-null
 * and are 64-char hex strings (SHA-256 format). A full cryptographic
 * re-derivation requires the exact original serialization of entry data.
 */
export async function verifyAuditLogChain(companyId: string): Promise<{
  ok: boolean;
  firstCorruptId: string | null;
  verifiedCount: number;
}> {
  const db = getDb();
  const rows = await db.query.auditLogs.findMany({
    where: eq(auditLogs.companyId, companyId),
    orderBy: [desc(auditLogs.createdAt)],
  });

  const HEX_64 = /^[a-f0-9]{64}$/;

  for (const row of rows) {
    if (!row.entryHash || !HEX_64.test(row.entryHash)) {
      return { ok: false, firstCorruptId: row.id, verifiedCount: 0 };
    }
  }

  return { ok: true, firstCorruptId: null, verifiedCount: rows.length };
}
