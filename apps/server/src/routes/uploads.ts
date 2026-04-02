/**
 * File upload routes
 *
 * GET /api/uploads/signed-url?filename=X&contentType=Y
 *   Generate a pre-signed PUT URL for direct upload to MinIO/S3.
 *   Key format: {companyId}/{userId}/{timestamp}-{filename}
 *   Returns: { url, key }
 */

import { Router } from "express";
import { z } from "zod";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { authenticate } from "../middleware/auth.js";
import { getEnv } from "../config/env.js";

const signedUrlQuerySchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100).default("application/octet-stream"),
});

function getUploadBucket(): string {
  // Reuse the main S3 bucket for uploads, under uploads/ prefix
  return getEnv().S3_BUCKET;
}

function getS3Client(): S3Client {
  const env = getEnv();
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });
}

export function uploadRoutes() {
  const router = Router();

  // GET /api/uploads/signed-url
  router.get("/signed-url", authenticate(), async (req, res, next) => {
    try {
      const parseResult = signedUrlQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "filename and contentType are required",
          },
        });
        return;
      }

      const { filename, contentType } = parseResult.data;
      const companyId = req.companyId!;
      const userId = req.userId!;
      const timestamp = Date.now();

      // Sanitize filename to avoid path traversal
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `uploads/${companyId}/${userId}/${timestamp}-${safeName}`;

      const client = getS3Client();
      const bucket = getUploadBucket();

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      });

      // Signed URL valid for 15 minutes
      const url = await getSignedUrl(client, command, { expiresIn: 900 });

      res.json({ url, key });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
