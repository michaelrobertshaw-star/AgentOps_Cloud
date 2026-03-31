import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

const DEPT_ID = "00000000-0000-0000-0000-000000000001";
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const COMPANY_ID = "co-1";
const USER_ID = "user-1";

const mockWorkspace = {
  id: WORKSPACE_ID,
  companyId: COMPANY_ID,
  departmentId: DEPT_ID,
  name: "Test Workspace",
  description: null,
  storagePath: `${COMPANY_ID}/departments/${DEPT_ID}/workspaces/${WORKSPACE_ID}`,
  storageBytes: 0,
  fileCount: 0,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockDept = {
  id: DEPT_ID,
  companyId: COMPANY_ID,
  name: "Engineering",
  status: "active",
};

// Mutable mock state for controlling query results
let workspaceFindFirstResult: typeof mockWorkspace | null = mockWorkspace;
let workspaceFindManyResult: typeof mockWorkspace[] = [mockWorkspace];
let departmentFindFirstResult: typeof mockDept | null = mockDept;

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      workspaces: {
        findMany: vi.fn(() => Promise.resolve(workspaceFindManyResult)),
        findFirst: vi.fn(() => Promise.resolve(workspaceFindFirstResult)),
      },
      departments: {
        findFirst: vi.fn(() => Promise.resolve(departmentFindFirstResult)),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([mockWorkspace])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ ...mockWorkspace, status: "archived" }])),
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

describe("Workspace routes", () => {
  const app = createApp();

  beforeEach(() => {
    workspaceFindFirstResult = mockWorkspace;
    workspaceFindManyResult = [mockWorkspace];
    departmentFindFirstResult = mockDept;
  });

  // =============================================
  // POST /api/departments/:deptId/workspaces
  // =============================================

  describe("POST /api/departments/:deptId/workspaces", () => {
    it("creates a workspace for oneops_admin", async () => {
      workspaceFindFirstResult = null; // no duplicate
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
      const res = await request(app)
        .post(`/api/departments/${DEPT_ID}/workspaces`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Test Workspace" });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe("Test Workspace");
    });

    it("creates a workspace for customer_admin", async () => {
      workspaceFindFirstResult = null;
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_admin"], {});
      const res = await request(app)
        .post(`/api/departments/${DEPT_ID}/workspaces`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Test Workspace" });
      expect(res.status).toBe(201);
    });

    it("creates a workspace for department_manager", async () => {
      workspaceFindFirstResult = null;
      const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
        [DEPT_ID]: "department_manager",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .post(`/api/departments/${DEPT_ID}/workspaces`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Test Workspace" });
      expect(res.status).toBe(201);
    });

    it("creates a workspace for operator", async () => {
      workspaceFindFirstResult = null;
      const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
        [DEPT_ID]: "operator",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .post(`/api/departments/${DEPT_ID}/workspaces`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Test Workspace" });
      expect(res.status).toBe(201);
    });

    it("returns 403 for viewer (no workspace:write)", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
        [DEPT_ID]: "viewer",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .post(`/api/departments/${DEPT_ID}/workspaces`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Test Workspace" });
      expect(res.status).toBe(403);
    });

    it("returns 403 for customer_user (no workspace:write)", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
      const res = await request(app)
        .post(`/api/departments/${DEPT_ID}/workspaces`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Test Workspace" });
      expect(res.status).toBe(403);
    });

    it("returns 400 for missing name", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
      const res = await request(app)
        .post(`/api/departments/${DEPT_ID}/workspaces`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const res = await request(app)
        .post(`/api/departments/${DEPT_ID}/workspaces`)
        .send({ name: "Test Workspace" });
      expect(res.status).toBe(401);
    });
  });

  // =============================================
  // GET /api/departments/:deptId/workspaces
  // =============================================

  describe("GET /api/departments/:deptId/workspaces", () => {
    it("returns workspaces for oneops_admin", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
      const res = await request(app)
        .get(`/api/departments/${DEPT_ID}/workspaces`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it("returns workspaces for customer_user", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
      const res = await request(app)
        .get(`/api/departments/${DEPT_ID}/workspaces`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("returns workspaces for department viewer", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
        [DEPT_ID]: "viewer",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .get(`/api/departments/${DEPT_ID}/workspaces`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("returns 401 without auth", async () => {
      const res = await request(app).get(`/api/departments/${DEPT_ID}/workspaces`);
      expect(res.status).toBe(401);
    });
  });

  // =============================================
  // GET /api/workspaces/:id
  // =============================================

  describe("GET /api/workspaces/:id", () => {
    it("returns workspace for oneops_admin", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
      const res = await request(app)
        .get(`/api/workspaces/${WORKSPACE_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(WORKSPACE_ID);
    });

    it("returns workspace for customer_user", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
      const res = await request(app)
        .get(`/api/workspaces/${WORKSPACE_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("returns workspace for department viewer", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
        [DEPT_ID]: "viewer",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .get(`/api/workspaces/${WORKSPACE_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("returns 404 for non-existent workspace", async () => {
      workspaceFindFirstResult = null;
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
      const res = await request(app)
        .get(`/api/workspaces/00000000-0000-0000-0000-000000000099`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}`);
      expect(res.status).toBe(401);
    });
  });

  // =============================================
  // PATCH /api/workspaces/:id
  // =============================================

  describe("PATCH /api/workspaces/:id", () => {
    it("updates workspace for oneops_admin", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
      const res = await request(app)
        .patch(`/api/workspaces/${WORKSPACE_ID}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Renamed Workspace" });
      expect(res.status).toBe(200);
    });

    it("updates workspace for department_manager", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
        [DEPT_ID]: "department_manager",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .patch(`/api/workspaces/${WORKSPACE_ID}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Renamed Workspace" });
      expect(res.status).toBe(200);
    });

    it("returns 403 for viewer", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
        [DEPT_ID]: "viewer",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .patch(`/api/workspaces/${WORKSPACE_ID}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Renamed Workspace" });
      expect(res.status).toBe(403);
    });

    it("returns 401 without auth", async () => {
      const res = await request(app)
        .patch(`/api/workspaces/${WORKSPACE_ID}`)
        .send({ name: "Renamed Workspace" });
      expect(res.status).toBe(401);
    });
  });

  // =============================================
  // DELETE /api/workspaces/:id (archive)
  // =============================================

  describe("DELETE /api/workspaces/:id", () => {
    it("archives workspace for oneops_admin", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
      const res = await request(app)
        .delete(`/api/workspaces/${WORKSPACE_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Workspace archived");
    });

    it("archives workspace for department_manager", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
        [DEPT_ID]: "department_manager",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .delete(`/api/workspaces/${WORKSPACE_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("returns 403 for viewer", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
        [DEPT_ID]: "viewer",
      } as Record<string, "department_manager" | "operator" | "viewer">);
      const res = await request(app)
        .delete(`/api/workspaces/${WORKSPACE_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("returns 403 for customer_user", async () => {
      const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
      const res = await request(app)
        .delete(`/api/workspaces/${WORKSPACE_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("returns 401 without auth", async () => {
      const res = await request(app).delete(`/api/workspaces/${WORKSPACE_ID}`);
      expect(res.status).toBe(401);
    });
  });
});
