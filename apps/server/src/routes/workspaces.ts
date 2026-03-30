import { Router } from "express";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import multer from "multer";
import { workspaces, departments, workspaceFiles } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError, ConflictError, AppError, ValidationError } from "../lib/errors.js";
import { getEnv } from "../config/env.js";
import {
  uploadWorkspaceFile,
  deleteWorkspaceFile,
  getWorkspaceFilePresignedUrl,
  downloadWorkspaceFile,
} from "../services/storageService.js";

// ================================================================
// MIME type denylist — block dangerous content types
// ================================================================
const BLOCKED_MIME_PREFIXES = ["text/html", "application/x-httpd-php"];
const BLOCKED_MIME_EXACT = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-sh",
  "application/x-csh",
]);

function isMimeAllowed(mime: string): boolean {
  const lower = mime.toLowerCase();
  if (BLOCKED_MIME_EXACT.has(lower)) return false;
  for (const prefix of BLOCKED_MIME_PREFIXES) {
    if (lower.startsWith(prefix)) return false;
  }
  return true;
}

// Path traversal guard
function isSafePath(filename: string): boolean {
  if (!filename || filename.trim().length === 0) return false;
  const normalized = filename.replace(/\\/g, "/");
  if (normalized.includes("..")) return false;
  if (normalized.startsWith("/")) return false;
  return true;
}

function buildUploadKey(workspaceId: string, fileId: string, filename: string): string {
  return `workspaces/${workspaceId}/files/${fileId}-${filename}`;
}

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
});

/**
 * Department-scoped workspace routes.
 * Mount at: /api/departments/:deptId/workspaces
 */
export function workspaceDeptRoutes() {
  const router = Router({ mergeParams: true });

  router.post(
    "/",
    authenticate(),
    requirePermission("workspace:write"),
    validate(createWorkspaceSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const deptId = req.params.deptId as string;

        const dept = await db.query.departments.findFirst({
          where: and(
            eq(departments.id, deptId),
            eq(departments.companyId, req.companyId!),
          ),
        });
        if (!dept) throw new NotFoundError("Department", deptId);

        const existing = await db.query.workspaces.findFirst({
          where: and(
            eq(workspaces.departmentId, deptId),
            eq(workspaces.name, req.body.name),
            eq(workspaces.companyId, req.companyId!),
          ),
        });
        if (existing) throw new ConflictError(`Workspace '${req.body.name}' already exists in this department`);

        const id = randomUUID();
        const storagePath = `${req.companyId}/departments/${deptId}/workspaces/${id}`;

        const [workspace] = await db
          .insert(workspaces)
          .values({ id, companyId: req.companyId!, departmentId: deptId, name: req.body.name, description: req.body.description, storagePath })
          .returning();

        await req.audit?.({ action: "workspace:create", resourceType: "workspace", resourceId: workspace.id, departmentId: deptId, riskLevel: "medium" });
        res.status(201).json(workspace);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/",
    authenticate(),
    requirePermission("workspace:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const deptId = req.params.deptId as string;

        const dept = await db.query.departments.findFirst({
          where: and(eq(departments.id, deptId), eq(departments.companyId, req.companyId!)),
        });
        if (!dept) throw new NotFoundError("Department", deptId);

        const results = await db.query.workspaces.findMany({
          where: and(eq(workspaces.departmentId, deptId), eq(workspaces.companyId, req.companyId!)),
        });
        res.json(results);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/**
 * Top-level workspace routes.
 * Mount at: /api/workspaces
 */
export function workspaceRoutes() {
  const router = Router();

  router.get("/:id", authenticate(), requirePermission("workspace:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const workspace = await db.query.workspaces.findFirst({
        where: and(eq(workspaces.id, req.params.id as string), eq(workspaces.companyId, req.companyId!)),
      });
      if (!workspace) throw new NotFoundError("Workspace", req.params.id as string);
      res.json(workspace);
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", authenticate(), requirePermission("workspace:write"), validate(updateWorkspaceSchema), async (req, res, next) => {
    try {
      const db = getDb();
      const [updated] = await db
        .update(workspaces)
        .set({ ...req.body, updatedAt: new Date() })
        .where(and(eq(workspaces.id, req.params.id as string), eq(workspaces.companyId, req.companyId!)))
        .returning();
      if (!updated) throw new NotFoundError("Workspace", req.params.id as string);
      await req.audit?.({ action: "workspace:update", resourceType: "workspace", resourceId: updated.id, departmentId: updated.departmentId, changes: { after: req.body } });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", authenticate(), requirePermission("workspace:write"), async (req, res, next) => {
    try {
      const db = getDb();
      const [updated] = await db
        .update(workspaces)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(workspaces.id, req.params.id as string), eq(workspaces.companyId, req.companyId!)))
        .returning();
      if (!updated) throw new NotFoundError("Workspace", req.params.id as string);
      await req.audit?.({ action: "workspace:archive", resourceType: "workspace", resourceId: updated.id, departmentId: updated.departmentId, riskLevel: "medium" });
      res.json({ message: "Workspace archived", workspace: updated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Workspace file routes.
 * Mount at: /api/workspaces/:workspaceId/files
 */
export function workspaceFileRoutes() {
  const router = Router({ mergeParams: true });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: getEnv().MAX_FILE_SIZE_BYTES },
  });

  // POST /api/workspaces/:workspaceId/files — upload
  router.post(
    "/",
    authenticate(),
    requirePermission("workspace:write"),
    upload.single("file"),
    async (req, res, next) => {
      try {
        if (!req.file) throw new ValidationError("No file uploaded. Use multipart/form-data with field 'file'.");

        const db = getDb();
        const workspaceId = req.params.workspaceId as string;

        const workspace = await db.query.workspaces.findFirst({
          where: and(eq(workspaces.id, workspaceId), eq(workspaces.companyId, req.companyId!)),
        });
        if (!workspace) throw new NotFoundError("Workspace", workspaceId);

        const filename = req.file.originalname;
        if (!isSafePath(filename)) throw new ValidationError("Invalid filename: path traversal not allowed.", { filename });

        const contentType = req.file.mimetype;
        if (!isMimeAllowed(contentType)) throw new ValidationError(`MIME type '${contentType}' is not allowed.`, { contentType });

        const checksum = createHash("sha256").update(req.file.buffer).digest("hex");
        const fileId = randomUUID();
        const storageKey = buildUploadKey(workspaceId, fileId, filename);

        await uploadWorkspaceFile(storageKey, req.file.buffer, contentType);

        const [record] = await db
          .insert(workspaceFiles)
          .values({
            id: fileId,
            companyId: req.companyId!,
            workspaceId,
            path: filename,
            sizeBytes: req.file.size,
            contentType,
            storageKey,
            checksum,
            uploadedByUserId: req.userId ?? null,
          })
          .returning();

        await db
          .update(workspaces)
          .set({ fileCount: workspace.fileCount + 1, storageBytes: workspace.storageBytes + req.file.size, updatedAt: new Date() })
          .where(eq(workspaces.id, workspaceId));

        await req.audit?.({ action: "workspace_file:upload", resourceType: "workspace_file", resourceId: record.id, riskLevel: "low" });
        res.status(201).json(record);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          return next(new AppError(413, "FILE_TOO_LARGE", "File exceeds maximum allowed size."));
        }
        next(err);
      }
    },
  );

  // GET /api/workspaces/:workspaceId/files — list (paginated)
  router.get(
    "/",
    authenticate(),
    requirePermission("workspace:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const workspaceId = req.params.workspaceId as string;

        const workspace = await db.query.workspaces.findFirst({
          where: and(eq(workspaces.id, workspaceId), eq(workspaces.companyId, req.companyId!)),
        });
        if (!workspace) throw new NotFoundError("Workspace", workspaceId);

        const files = await db.query.workspaceFiles.findMany({
          where: and(
            eq(workspaceFiles.workspaceId, workspaceId),
            eq(workspaceFiles.companyId, req.companyId!),
            isNull(workspaceFiles.deletedAt),
          ),
        });

        const page = Math.max(1, Number(req.query.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
        const start = (page - 1) * limit;

        res.json({ data: files.slice(start, start + limit), total: files.length, page, limit });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/workspaces/:workspaceId/files/:fileId — metadata
  router.get(
    "/:fileId",
    authenticate(),
    requirePermission("workspace:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const { workspaceId, fileId } = req.params as { workspaceId: string; fileId: string };

        const file = await db.query.workspaceFiles.findFirst({
          where: and(
            eq(workspaceFiles.id, fileId),
            eq(workspaceFiles.workspaceId, workspaceId),
            eq(workspaceFiles.companyId, req.companyId!),
            isNull(workspaceFiles.deletedAt),
          ),
        });
        if (!file) throw new NotFoundError("WorkspaceFile", fileId);
        res.json(file);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/workspaces/:workspaceId/files/:fileId/download — presigned URL (15 min TTL)
  router.get(
    "/:fileId/download",
    authenticate(),
    requirePermission("workspace:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const { workspaceId, fileId } = req.params as { workspaceId: string; fileId: string };

        const file = await db.query.workspaceFiles.findFirst({
          where: and(
            eq(workspaceFiles.id, fileId),
            eq(workspaceFiles.workspaceId, workspaceId),
            eq(workspaceFiles.companyId, req.companyId!),
            isNull(workspaceFiles.deletedAt),
          ),
        });
        if (!file) throw new NotFoundError("WorkspaceFile", fileId);

        try {
          const url = await getWorkspaceFilePresignedUrl(file.storageKey, 900);
          res.redirect(302, url);
        } catch {
          // Fallback: proxy
          const { body, contentType } = await downloadWorkspaceFile(file.storageKey);
          if (file.checksum) {
            const downloaded = createHash("sha256").update(body).digest("hex");
            if (downloaded !== file.checksum) throw new AppError(500, "CHECKSUM_MISMATCH", "File integrity check failed.");
          }
          res.setHeader("Content-Type", contentType);
          res.setHeader("Content-Disposition", `attachment; filename="${file.path}"`);
          res.setHeader("Content-Length", String(body.length));
          res.send(body);
        }
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/workspaces/:workspaceId/files/:fileId — soft delete
  router.delete(
    "/:fileId",
    authenticate(),
    requirePermission("workspace:write"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const { workspaceId, fileId } = req.params as { workspaceId: string; fileId: string };

        const file = await db.query.workspaceFiles.findFirst({
          where: and(
            eq(workspaceFiles.id, fileId),
            eq(workspaceFiles.workspaceId, workspaceId),
            eq(workspaceFiles.companyId, req.companyId!),
            isNull(workspaceFiles.deletedAt),
          ),
        });
        if (!file) throw new NotFoundError("WorkspaceFile", fileId);

        await deleteWorkspaceFile(file.storageKey);
        await db.update(workspaceFiles).set({ deletedAt: new Date() }).where(eq(workspaceFiles.id, fileId));

        const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
        if (workspace) {
          await db
            .update(workspaces)
            .set({ fileCount: Math.max(0, workspace.fileCount - 1), storageBytes: Math.max(0, workspace.storageBytes - file.sizeBytes), updatedAt: new Date() })
            .where(eq(workspaces.id, workspaceId));
        }

        await req.audit?.({ action: "workspace_file:delete", resourceType: "workspace_file", resourceId: fileId, riskLevel: "medium" });
        res.json({ message: "File deleted", fileId });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
