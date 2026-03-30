/**
 * M3 QA: Regression + feature scaffolds
 *
 * Section 1 — M1 Regression: auth + CRUD flows still pass
 * Section 2 — M2 Regression: agent/task flows still pass
 * Section 3 — M3 Scaffolds: workspace, incidents, webhooks (todo when routes land)
 * Section 4 — RBAC enforcement across new M3 endpoints
 * Section 5 — Security: file upload path-traversal & MIME bypass checks
 *
 * Scaffold tests are marked it.todo() — they will be activated as M3 routes
 * are implemented by the engineering team.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    eval: vi.fn().mockResolvedValue([1, Math.floor(Date.now() / 1000) - 30]),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      tasks: {
        findMany: vi.fn(() => Promise.resolve([])),
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
      departments: {
        findFirst: vi.fn(() =>
          Promise.resolve({ id: "dept-1", companyId: "co-1", name: "Engineering" }),
        ),
      },
      agents: {
        findMany: vi.fn(() => Promise.resolve([])),
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
      agentApiKeys: {
        findMany: vi.fn(() => Promise.resolve([])),
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
      taskRuns: {
        findMany: vi.fn(() => Promise.resolve([])),
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
            {
              id: "task-1",
              companyId: "co-1",
              departmentId: "00000000-0000-0000-0000-000000000001",
              title: "Regression Task",
              status: "pending",
              priority: "medium",
              agentId: null,
              parentTaskId: null,
              description: null,
              input: null,
              output: null,
              error: null,
              retryCount: 0,
              maxRetries: 3,
              timeoutSeconds: 1800,
              runTokenId: null,
              scheduledAt: null,
              startedAt: null,
              completedAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
  }),
}));

vi.mock("../middleware/audit.js", () => ({
  auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => {
    (_req as { audit: () => Promise<void> }).audit = async () => {};
    next();
  },
}));

// ---------------------------------------------------------------------------
// Section 1 — M1 Regression: Auth + CRUD
// ---------------------------------------------------------------------------

describe("M1 Regression: Auth endpoints", () => {
  const app = createApp();

  it("GET /api/health returns 200", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("POST /api/auth/register returns 400 for missing fields", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({});
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/login returns 400 for missing credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({});
    expect(res.status).toBe(400);
  });

  it("GET /api/companies/me returns 401 without auth", async () => {
    // Companies router only exposes /me — bare /api/companies has no handler
    const res = await request(app).get("/api/companies/me");
    expect(res.status).toBe(401);
  });

  it("GET /api/departments returns 401 without auth", async () => {
    const res = await request(app).get("/api/departments");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — M2 Regression: Agent + Task flows
// ---------------------------------------------------------------------------

describe("M2 Regression: Agent routes", () => {
  const app = createApp();

  it("GET /api/agents returns 200 for company_admin", async () => {
    const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
    const res = await request(app)
      .get("/api/agents")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/agents returns 401 without auth", async () => {
    const res = await request(app).get("/api/agents");
    expect(res.status).toBe(401);
  });

  it("GET /api/agents returns 200 for department viewer (viewer has agent:view)", async () => {
    // Per RBAC matrix: department 'viewer' role includes 'agent:view'
    const token = await issueAccessToken("user-1", "co-1", [], {
      "dept-1": "viewer",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .get("/api/agents")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("M2 Regression: Task routes", () => {
  const app = createApp();

  it("GET /api/tasks returns 200 for company_admin", async () => {
    const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
    const res = await request(app)
      .get("/api/tasks")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("POST /api/tasks returns 201 for operator", async () => {
    const token = await issueAccessToken("user-1", "co-1", [], {
      "00000000-0000-0000-0000-000000000001": "operator",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .post("/api/tasks")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Regression Task",
        departmentId: "00000000-0000-0000-0000-000000000001",
      });
    expect(res.status).toBe(201);
  });

  it("POST /api/tasks returns 403 for viewer", async () => {
    const token = await issueAccessToken("user-1", "co-1", [], {
      "00000000-0000-0000-0000-000000000001": "viewer",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .post("/api/tasks")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Regression Task",
        departmentId: "00000000-0000-0000-0000-000000000001",
      });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Section 3 — M3 Feature Scaffolds (activate when routes land)
// ---------------------------------------------------------------------------

describe("M3 Scaffold: Workspace CRUD (routes pending implementation)", () => {
  it.todo("POST /api/workspaces — creates workspace, returns 201 with id");
  it.todo("GET /api/workspaces — lists workspaces for company_admin");
  it.todo("GET /api/workspaces/:id — returns workspace detail");
  it.todo("PATCH /api/workspaces/:id — archives workspace");
  it.todo("POST /api/workspaces — returns 403 for viewer");
  it.todo("GET /api/workspaces returns 401 without auth");
});

describe("M3 Scaffold: File Upload & Download (routes pending implementation)", () => {
  it.todo("POST /api/workspaces/:id/files — uploads valid file, stored in MinIO");
  it.todo("POST /api/workspaces/:id/files — rejects invalid MIME type (text/html blocked)");
  it.todo("GET /api/workspaces/:id/files/:fileId/download — returns presigned URL");
  it.todo("Checksum: downloaded file content matches uploaded content");
  it.todo("DELETE /api/workspaces/:id/files/:fileId — removes from MinIO and DB");
  it.todo("DELETE /api/workspaces/:id/files/:fileId — returns 403 for viewer");
  it.todo("DELETE /api/workspaces/:id/files/:fileId — returns 200 for manager");
  it.todo("Security: path traversal attempt ('../../../etc/passwd') rejected with 400");
  it.todo("Security: MIME bypass (rename .exe to .jpg) detected and rejected");
});

describe("M3 Scaffold: Incidents (routes pending implementation)", () => {
  it.todo("POST /api/incidents — creates incident with status=open");
  it.todo("PATCH /api/incidents/:id — transitions open → investigating");
  it.todo("PATCH /api/incidents/:id — transitions investigating → resolved");
  it.todo("PATCH /api/incidents/:id — transitions resolved → closed");
  it.todo("PATCH /api/incidents/:id — invalid status transition returns 422");
  it.todo("POST /api/incidents/:id/attachments — attaches workspace file to incident");
  it.todo("RBAC: operator can create incidents");
  it.todo("RBAC: manager can resolve incidents");
  it.todo("RBAC: only admin can close incidents");
  it.todo("RBAC: viewer cannot create or transition incidents");
});

describe("M3 Scaffold: Webhooks (routes pending implementation)", () => {
  it.todo("POST /api/webhooks — creates webhook endpoint");
  it.todo("POST /api/webhooks/:id/ping — sends test ping, returns HMAC signature");
  it.todo("Webhook event: incident.created event delivered to webhook_deliveries log");
  it.todo("Webhook retry: mock failing endpoint triggers 3 retry attempts");
  it.todo("Webhook HMAC: delivery signature verifiable with shared secret");
});

describe("M3 Scaffold: WebSocket real-time events (full flow pending M3 routes)", () => {
  it.todo("task.status_changed received in real-time via WebSocket when task updated");
  it.todo("incident.created event broadcast to department subscribers");
  it.todo("Subscribe to department channel — only receive events for that department");
});

// ---------------------------------------------------------------------------
// Section 4 — RBAC enforcement across all M3 endpoints
// ---------------------------------------------------------------------------

describe("M3 RBAC scaffold: all new endpoints respect auth", () => {
  const app = createApp();

  it("unauthenticated requests to protected endpoints return 401", async () => {
    // Pre-flight: verify the existing auth middleware is functional
    const routes = [
      "/api/agents",
      "/api/tasks",
      "/api/departments",
    ];

    for (const route of routes) {
      const res = await request(app).get(route);
      expect(res.status, `Expected 401 for ${route}`).toBe(401);
    }
  });

  it.todo("GET /api/workspaces returns 401 without auth");
  it.todo("GET /api/incidents returns 401 without auth");
  it.todo("GET /api/webhooks returns 401 without auth");
});
