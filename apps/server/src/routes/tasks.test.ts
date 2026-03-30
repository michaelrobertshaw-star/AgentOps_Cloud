import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

// Mock the database
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
              title: "Test Task",
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

describe("Task routes", () => {
  const app = createApp();

  describe("GET /api/tasks", () => {
    it("returns 200 for company_admin", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
      const res = await request(app)
        .get("/api/tasks")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("returns 200 for auditor (task:view)", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["auditor"], {});
      const res = await request(app)
        .get("/api/tasks")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("returns 200 for department viewer", async () => {
      const token = await issueAccessToken("user-1", "co-1", [], {
        "dept-1": "viewer",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .get("/api/tasks")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("returns 401 without auth", async () => {
      const res = await request(app).get("/api/tasks");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/tasks", () => {
    it("creates a task for company_admin", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
      const res = await request(app)
        .post("/api/tasks")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Test Task",
          departmentId: "00000000-0000-0000-0000-000000000001",
          priority: "medium",
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.title).toBe("Test Task");
    });

    it("returns 400 for missing required fields", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
      const res = await request(app)
        .post("/api/tasks")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "" });
      expect(res.status).toBe(400);
    });

    it("returns 403 for auditor (no task:create)", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["auditor"], {});
      const res = await request(app)
        .post("/api/tasks")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Test Task",
          departmentId: "00000000-0000-0000-0000-000000000001",
        });
      expect(res.status).toBe(403);
    });

    it("allows operator to create tasks", async () => {
      const token = await issueAccessToken("user-1", "co-1", [], {
        "00000000-0000-0000-0000-000000000001": "operator",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .post("/api/tasks")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Test Task",
          departmentId: "00000000-0000-0000-0000-000000000001",
        });
      expect(res.status).toBe(201);
    });

    it("denies viewer from creating tasks", async () => {
      const token = await issueAccessToken("user-1", "co-1", [], {
        "00000000-0000-0000-0000-000000000001": "viewer",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .post("/api/tasks")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Test Task",
          departmentId: "00000000-0000-0000-0000-000000000001",
        });
      expect(res.status).toBe(403);
    });
  });
});

describe("Task status transition validation", () => {
  it("validates task priority enum", async () => {
    const app = createApp();
    const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
    const res = await request(app)
      .post("/api/tasks")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Test Task",
        departmentId: "00000000-0000-0000-0000-000000000001",
        priority: "invalid_priority",
      });
    expect(res.status).toBe(400);
  });
});
