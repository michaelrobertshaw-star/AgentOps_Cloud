/**
 * Audit archive service — BullMQ-based async jobs for:
 *   - Hash chain verification (expensive, runs in background)
 *   - Archiving old audit log entries to S3 as gzip NDJSON
 */
import { Queue } from "bullmq";
import { gzipSync } from "node:zlib";
import { eq, and, lt, asc } from "drizzle-orm";
import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { auditLogs, companies } from "@agentops/db";
import { getDb } from "../lib/db.js";
import { getEnv } from "../config/env.js";
import { verifyAuditLogChain } from "./auditService.js";
import pino from "pino";

const logger = pino({ name: "audit-archive" });

// ── Redis connection ────────────────────────────────────────────────────────

function getRedisConnection() {
  const url = new URL(getEnv().REDIS_URL);
  return { host: url.hostname, port: Number(url.port) || 6379 };
}

// ── BullMQ Queue ────────────────────────────────────────────────────────────

let auditQueue: Queue | undefined;

export function getAuditQueue(): Queue {
  if (!auditQueue) {
    auditQueue = new Queue("audit-archive", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });
  }
  return auditQueue;
}

/**
 * Enqueue an async hash-chain verification job.
 * Returns the BullMQ job ID immediately; verification runs in the background.
 */
export async function enqueueVerifyChain(companyId: string): Promise<string> {
  const queue = getAuditQueue();
  const job = await queue.add("verify-chain", { companyId, type: "verify" });
  return job.id!;
}

/**
 * Enqueue an async archival job.
 * Returns the BullMQ job ID; archival runs in the background.
 */
export async function enqueueArchive(companyId: string): Promise<string> {
  const queue = getAuditQueue();
  const job = await queue.add("archive", { companyId, type: "archive" });
  return job.id!;
}

// ── S3 client ───────────────────────────────────────────────────────────────

function makeS3Client(): S3Client {
  const env = getEnv();
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
    forcePathStyle: true, // Required for MinIO
  });
}

// ── Archive ─────────────────────────────────────────────────────────────────

/**
 * Archive audit log entries older than `retentionDays` to S3 as gzip NDJSON.
 * Returns the S3 key of the created archive, or null if there was nothing to archive.
 */
export async function archiveAuditLogs(
  companyId: string,
  retentionDays: number = 90,
): Promise<string | null> {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const rows = await db.query.auditLogs.findMany({
    where: and(eq(auditLogs.companyId, companyId), lt(auditLogs.createdAt, cutoff)),
    orderBy: [asc(auditLogs.createdAt)],
  });

  if (rows.length === 0) {
    logger.info({ companyId, retentionDays }, "No audit logs to archive");
    return null;
  }

  // Serialize as NDJSON (one JSON object per line)
  const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
  const compressed = gzipSync(Buffer.from(ndjson, "utf-8"));

  const env = getEnv();
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `${companyId}/archive-${dateStr}-${Date.now()}.ndjson.gz`;

  const client = makeS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_AUDIT_BUCKET,
      Key: key,
      Body: compressed,
      ContentType: "application/gzip",
      Metadata: {
        companyId,
        recordCount: String(rows.length),
        dateFrom: rows[0].createdAt.toISOString(),
        dateTo: rows[rows.length - 1].createdAt.toISOString(),
      },
    }),
  );

  logger.info({ companyId, key, recordCount: rows.length }, "Audit logs archived to S3");
  return key;
}

/**
 * List audit archive files for a company from S3.
 */
export async function listAuditArchives(companyId: string): Promise<
  Array<{
    key: string;
    size: number;
    lastModified: Date;
  }>
> {
  const env = getEnv();
  const client = makeS3Client();
  const prefix = `${companyId}/`;

  const response = await client.send(
    new ListObjectsV2Command({ Bucket: env.S3_AUDIT_BUCKET, Prefix: prefix }),
  );

  return (response.Contents ?? []).map((obj) => ({
    key: obj.Key ?? "",
    size: obj.Size ?? 0,
    lastModified: obj.LastModified ?? new Date(),
  }));
}

// ── Job processor (called by worker when running) ───────────────────────────

export async function processAuditJob(job: {
  name: string;
  data: { companyId: string; type: string };
}): Promise<void> {
  const { companyId, type } = job.data;

  if (type === "verify") {
    logger.info({ companyId }, "Running async hash-chain verification");
    const result = await verifyAuditLogChain(companyId);
    logger.info({ companyId, ...result }, "Hash-chain verification complete");
    return;
  }

  if (type === "archive") {
    logger.info({ companyId }, "Running async audit log archival");
    const db = getDb();
    const company = await db.query.companies.findFirst({
      where: eq(companies.id, companyId),
    });
    const retentionDays = company?.auditRetentionDays ?? 90;
    const key = await archiveAuditLogs(companyId, retentionDays);
    logger.info({ companyId, key }, "Audit log archival complete");
    return;
  }

  logger.warn({ companyId, type }, "Unknown audit job type");
}
