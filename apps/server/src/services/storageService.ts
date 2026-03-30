import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getEnv } from "../config/env.js";
import pino from "pino";

const logger = pino({ name: "storage" });

let s3Client: S3Client | undefined;

function getS3Client(): S3Client {
  if (!s3Client) {
    const env = getEnv();
    s3Client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
      },
      forcePathStyle: true, // Required for MinIO
    });
  }
  return s3Client;
}

function getBucket(): string {
  return getEnv().S3_BUCKET;
}

function getWorkspaceBucket(): string {
  return getEnv().S3_WORKSPACE_BUCKET;
}

function getAuditBucket(): string {
  return getEnv().S3_AUDIT_BUCKET;
}

/**
 * Build the S3 key for a task output artifact.
 * Format: {companyId}/{taskId}/runs/{runNumber}/{filename}
 */
export function buildOutputKey(
  companyId: string,
  taskId: string,
  runNumber: number,
  filename: string,
): string {
  return `${companyId}/${taskId}/runs/${runNumber}/${filename}`;
}

/**
 * Upload task output to S3/MinIO.
 */
export async function uploadTaskOutput(
  key: string,
  body: Buffer | string,
  contentType: string = "application/json",
): Promise<string> {
  const client = getS3Client();
  const bucket = getBucket();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
      ContentType: contentType,
    }),
  );

  const ref = `s3://${bucket}/${key}`;
  logger.info({ key, bucket }, "Uploaded task output");
  return ref;
}

/**
 * Download task output from S3/MinIO.
 */
export async function downloadTaskOutput(key: string): Promise<{
  body: Buffer;
  contentType: string;
}> {
  const client = getS3Client();
  const bucket = getBucket();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  const body = await streamToBuffer(response.Body as NodeJS.ReadableStream);
  return {
    body,
    contentType: response.ContentType || "application/octet-stream",
  };
}

/**
 * Check if an object exists.
 */
export async function outputExists(key: string): Promise<boolean> {
  const client = getS3Client();
  const bucket = getBucket();

  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete task output from S3/MinIO.
 */
export async function deleteTaskOutput(key: string): Promise<void> {
  const client = getS3Client();
  const bucket = getBucket();

  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  logger.info({ key, bucket }, "Deleted task output");
}

/**
 * Parse an S3 reference (s3://bucket/key) back to just the key.
 */
export function parseOutputRef(ref: string): { bucket: string; key: string } {
  const stripped = ref.replace("s3://", "");
  const slashIndex = stripped.indexOf("/");
  return {
    bucket: stripped.slice(0, slashIndex),
    key: stripped.slice(slashIndex + 1),
  };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Build the S3 key for a workspace file.
 * Format: {workspaceId}/{filepath}
 */
export function buildWorkspaceFileKey(
  workspaceId: string,
  filepath: string,
): string {
  return `${workspaceId}/${filepath}`;
}

/**
 * Upload a file to the workspace bucket.
 */
export async function uploadWorkspaceFile(
  key: string,
  body: Buffer | string,
  contentType: string = "application/octet-stream",
): Promise<string> {
  const client = getS3Client();
  const bucket = getWorkspaceBucket();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
      ContentType: contentType,
    }),
  );

  const ref = `s3://${bucket}/${key}`;
  logger.info({ key, bucket }, "Uploaded workspace file");
  return ref;
}

/**
 * Download a file from the workspace bucket.
 */
export async function downloadWorkspaceFile(key: string): Promise<{
  body: Buffer;
  contentType: string;
}> {
  const client = getS3Client();
  const bucket = getWorkspaceBucket();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  const body = await streamToBuffer(response.Body as NodeJS.ReadableStream);
  return {
    body,
    contentType: response.ContentType || "application/octet-stream",
  };
}

/**
 * Check if a workspace file exists.
 */
export async function workspaceFileExists(key: string): Promise<boolean> {
  const client = getS3Client();
  const bucket = getWorkspaceBucket();

  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a workspace file.
 */
export async function deleteWorkspaceFile(key: string): Promise<void> {
  const client = getS3Client();
  const bucket = getWorkspaceBucket();

  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  logger.info({ key, bucket }, "Deleted workspace file");
}

/**
 * List files in a workspace.
 */
export async function listWorkspaceFiles(
  workspaceId: string,
): Promise<string[]> {
  const client = getS3Client();
  const bucket = getWorkspaceBucket();
  const prefix = `${workspaceId}/`;

  const response = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
  );

  return (response.Contents ?? [])
    .map((obj) => obj.Key ?? "")
    .filter(Boolean)
    .map((key) => key.slice(prefix.length));
}

/**
 * Generate a presigned URL for a workspace file download.
 * Default TTL: 15 minutes (900 seconds).
 */
export async function getWorkspaceFilePresignedUrl(
  key: string,
  expiresIn = 900,
): Promise<string> {
  const client = getS3Client();
  const bucket = getWorkspaceBucket();

  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Check MinIO connectivity by pinging the workspace bucket.
 */
export async function checkMinioHealth(): Promise<{
  healthy: boolean;
  error?: string;
}> {
  const client = getS3Client();
  const bucket = getWorkspaceBucket();

  try {
    await client.send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }),
    );
    return { healthy: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ error }, "MinIO health check failed");
    return { healthy: false, error };
  }
}
