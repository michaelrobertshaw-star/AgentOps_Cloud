/**
 * Integration tests for M3.2: Workspace file upload/download/delete routes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const FILE_ID = "00000000-0000-0000-0000-000000000010";
const COMPANY_ID = "co-1";
const USER_ID = "user-1";

const mockWorkspace = {
  id: WORKSPACE_ID,
  companyId: COMPANY_ID,
  departmentId: "00000000-0000-0000-0000-000000000001",
  name: "Test Workspace",
  storagePath: "co-1/workspaces/" + WORKSPACE_ID,
  storageBytes: 0,
  fileCount: 0,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockFile = {
  id: FILE_ID,
  companyId: COMPANY_ID,
  workspaceId: WORKSPACE_ID,
  path: "hello.txt",
  sizeBytes: 15,
  contentType: "text/plain",
  storageKey: `workspaces/${WORKSPACE_ID}/files/${FILE_ID}-hello.txt`,
  checksum: "b94f6f125c79e3a5ffaa826f584c10d52ada669e6762051b826b55776d05a8a7",
  uploadedByUserId: USER_ID,
  uploadedByAgentId: null,
  deletedAt: null,
  createdAt: new Date(),
};

// ----------------------------------------------------------------
// Mutable state
// ----------------------------------------------------------------
let workspaceFindFirst: typeof mockWorkspace | null = mockWorkspace;
let fileFindFirst: typeof mockFile | null = mockFile;
let fileFindMany: typeof mockFile[] = [mockFile];
const insertReturning = vi.fn(() => Promise.resolve([mockFile]));
const updateWhere = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([mockFile])) }));
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      workspaces: { findFirst: vi.fn(() => Promise.resolve(workspaceFindFirst)) },
      workspaceFiles: {
        findFirst: vi.fn(() => Promise.resolve(fileFindFirst)),
        findMany: vi.fn(() => Promise.resolve(fileFindMany)),
      },
    },
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: insertReturning })) })),
    update: vi.fn(() => ({ set: updateSet })),
  }),
}));

vi.mock("../middleware/audit.js", () => ({
  auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => {
    (_req as { audit: () => Promise<void> }).audit = async () => {};
    next();
  },
}));

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    eval: vi.fn().mockResolvedValue([1, Math.floor(Date.now() / 1000) - 30]),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../services/storageService.js", () => ({
  uploadWorkspaceFile: vi.fn().mockResolvedValue("s3://workspaces/key"),
  deleteWorkspaceFile: vi.fn().mockResolvedValue(undefined),
  getWorkspaceFilePresignedUrl: vi.fn().mockResolvedValue("https://minio.example.com/presigned?foo=bar"),
  downloadWorkspaceFile: vi.fn().mockResolvedValue({
    body: Buffer.from("hello workspace"),
    contentType: "text/plain",
  }),
  checkMinioHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

// ----------------------------------------------------------------
// Tests: POST (upload)
// ----------------------------------------------------------------

describe("POST /api/workspaces/:id/files", () => {
  const app = createApp();

  beforeEach(() => {
    workspaceFindFirst = mockWorkspace;
    fileFindFirst = mockFile;
    fileFindMany = [mockFile];
    insertReturning.mockResolvedValue([mockFile]);
    updateSet.mockReturnValue({ where: updateWhere });
  });

  it("uploads a file for oneops_admin and returns 201", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello workspace"), { filename: "hello.txt", contentType: "text/plain" });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
  });

  it("uploads a file for operator", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      "00000000-0000-0000-0000-000000000001": "operator",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("content"), { filename: "op.txt", contentType: "text/plain" });
    expect(res.status).toBe(201);
  });

  it("returns 403 for viewer (no workspace:write)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      "00000000-0000-0000-0000-000000000001": "viewer",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("x"), { filename: "evil.txt", contentType: "text/plain" });
    expect(res.status).toBe(403);
  });

  it("returns 403 for customer_user (no workspace:write)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("x"), { filename: "x.txt", contentType: "text/plain" });
    expect(res.status).toBe(403);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files`)
      .attach("file", Buffer.from("x"), { filename: "x.txt", contentType: "text/plain" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when no file field is provided", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("rejects path traversal filename", async () => {
    // Note: form-data's path.basename() strips directory separators, so we test
    // a filename that still contains ".." after normalization (e.g. "..file").
    // In production, raw HTTP clients can send "../../etc/passwd" directly, which
    // our isSafePath() check catches because it looks for any ".." substring.
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("bad"), { filename: "..evil.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
  });

  it("rejects blocked MIME type text/html", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("<html>evil</html>"), { filename: "evil.html", contentType: "text/html" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when workspace not found", async () => {
    workspaceFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .post(`/api/workspaces/00000000-0000-0000-0000-000000000099/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("x"), { filename: "x.txt", contentType: "text/plain" });
    expect(res.status).toBe(404);
  });
});

// ----------------------------------------------------------------
// Tests: GET list
// ----------------------------------------------------------------

describe("GET /api/workspaces/:id/files", () => {
  const app = createApp();

  beforeEach(() => {
    workspaceFindFirst = mockWorkspace;
    fileFindMany = [mockFile];
  });

  it("returns paginated file list for oneops_admin", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/files`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("page");
    expect(res.body).toHaveProperty("limit");
  });

  it("returns file list for customer_user (workspace:view)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/files`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("returns file list for department viewer", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      "00000000-0000-0000-0000-000000000001": "viewer",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/files`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files`);
    expect(res.status).toBe(401);
  });
});

// ----------------------------------------------------------------
// Tests: GET metadata
// ----------------------------------------------------------------

describe("GET /api/workspaces/:id/files/:fileId", () => {
  const app = createApp();

  beforeEach(() => {
    workspaceFindFirst = mockWorkspace;
    fileFindFirst = mockFile;
  });

  it("returns file metadata for oneops_admin", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/files/${FILE_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(FILE_ID);
  });

  it("returns 404 for non-existent file", async () => {
    fileFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/files/00000000-0000-0000-0000-000000000099`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files/${FILE_ID}`);
    expect(res.status).toBe(401);
  });
});

// ----------------------------------------------------------------
// Tests: GET download (presigned URL)
// ----------------------------------------------------------------

describe("GET /api/workspaces/:id/files/:fileId/download", () => {
  const app = createApp();

  beforeEach(() => {
    fileFindFirst = mockFile;
  });

  it("redirects to presigned URL for oneops_admin", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/files/${FILE_ID}/download`)
      .set("Authorization", `Bearer ${token}`)
      .redirects(0);
    expect([301, 302]).toContain(res.status);
    expect(res.headers.location).toContain("presigned");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/files/${FILE_ID}/download`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when file not found", async () => {
    fileFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/files/00000000-0000-0000-0000-000000000099/download`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

// ----------------------------------------------------------------
// Tests: DELETE (soft delete)
// ----------------------------------------------------------------

describe("DELETE /api/workspaces/:id/files/:fileId", () => {
  const app = createApp();

  beforeEach(() => {
    fileFindFirst = mockFile;
    workspaceFindFirst = mockWorkspace;
    updateSet.mockReturnValue({ where: updateWhere });
  });

  it("deletes file for department_manager and returns 200", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      "00000000-0000-0000-0000-000000000001": "department_manager",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/files/${FILE_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("File deleted");
  });

  it("deletes file for oneops_admin", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/files/${FILE_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("returns 403 for viewer (no workspace:write)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      "00000000-0000-0000-0000-000000000001": "viewer",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/files/${FILE_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 for customer_user", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/files/${FILE_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/files/${FILE_ID}`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when file not found", async () => {
    fileFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/files/00000000-0000-0000-0000-000000000099`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
