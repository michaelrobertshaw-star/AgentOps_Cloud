import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

// Mock the database
const mockAgents: Record<string, unknown>[] = [];
let mockDepartments: Record<string, unknown>[] = [];

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      agents: {
        findMany: vi.fn(({ where }: { where?: unknown }) => {
          // Return all mock agents (filtering handled in route)
          return Promise.resolve(mockAgents);
        }),
        findFirst: vi.fn(({ where }: { where?: unknown }) => {
          // Simple mock: check if any agent matches by name or id
          return Promise.resolve(
            mockAgents.find((a) => {
              return true; // Let the test setup control this
            }),
          );
        }),
      },
      departments: {
        findFirst: vi.fn(() => {
          return Promise.resolve(mockDepartments[0] || null);
        }),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
            {
              id: "agent-1",
              companyId: "co-1",
              name: "test-agent",
              type: "worker",
              status: "draft",
              departmentId: null,
              version: null,
              description: null,
              executionPolicy: {
                max_concurrent_tasks: 1,
                timeout_seconds: 1800,
                retry_policy: { max_retries: 3, backoff: "exponential" },
              },
              capabilities: [],
              config: {},
              lastHeartbeatAt: null,
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
          returning: vi.fn(() =>
            Promise.resolve([
              {
                id: "agent-1",
                companyId: "co-1",
                name: "test-agent",
                type: "worker",
                status: "archived",
                departmentId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
          ),
        })),
      })),
    })),
  }),
}));

// Mock audit middleware to be a no-op
vi.mock("../middleware/audit.js", () => ({
  auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => {
    (_req as { audit: () => Promise<void> }).audit = async () => {};
    next();
  },
}));

describe("Agent routes", () => {
  const app = createApp();

  beforeEach(() => {
    mockAgents.length = 0;
    mockDepartments = [];
  });

  describe("GET /api/agents", () => {
    it("returns 200 for oneops_admin", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});
      const res = await request(app)
        .get("/api/agents")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("returns 200 for customer_admin", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["customer_admin"], {});
      const res = await request(app)
        .get("/api/agents")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("returns 200 for customer_user (read-only agent:view)", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["customer_user"], {});
      const res = await request(app)
        .get("/api/agents")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("returns 401 without auth", async () => {
      const res = await request(app).get("/api/agents");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/agents", () => {
    it("creates an agent for oneops_admin", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});
      const res = await request(app)
        .post("/api/agents")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "test-agent", type: "worker" });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe("test-agent");
    });

    it("returns 400 for missing required fields", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});
      const res = await request(app)
        .post("/api/agents")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "" });
      expect(res.status).toBe(400);
    });

    it("returns 403 for customer_user (no agent:create)", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["customer_user"], {});
      const res = await request(app)
        .post("/api/agents")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "test-agent", type: "worker" });
      expect(res.status).toBe(403);
    });

    it("allows department_manager to create agents", async () => {
      const token = await issueAccessToken("user-1", "co-1", [], {
        "dept-1": "department_manager",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .post("/api/agents")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "test-agent", type: "worker" });
      expect(res.status).toBe(201);
    });

    it("denies operator from creating agents", async () => {
      const token = await issueAccessToken("user-1", "co-1", [], {
        "dept-1": "operator",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .post("/api/agents")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "test-agent", type: "worker" });
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /api/agents/:id", () => {
    it("returns 403 for customer_user", async () => {
      const token = await issueAccessToken("user-1", "co-1", ["customer_user"], {});
      const res = await request(app)
        .delete("/api/agents/agent-1")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  });
});
