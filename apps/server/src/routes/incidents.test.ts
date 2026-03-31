/**
 * Integration tests for M3.3: Incident CRUD and lifecycle management.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------
const DEPT_ID = "00000000-0000-0000-0000-000000000001";
const COMPANY_ID = "co-1";
const USER_ID = "user-1";
const INCIDENT_ID = "00000000-0000-0000-0000-000000000050";
const FILE_ID = "00000000-0000-0000-0000-000000000010";

const mockDept = {
  id: DEPT_ID,
  companyId: COMPANY_ID,
  name: "Engineering",
  description: null,
  managerUserId: null,
  status: "active",
  settings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockIncident = {
  id: INCIDENT_ID,
  companyId: COMPANY_ID,
  departmentId: DEPT_ID,
  taskId: null,
  agentId: null,
  title: "API down",
  description: "API is returning 500 errors",
  severity: "high",
  status: "open",
  resolution: null,
  resolvedAt: null,
  resolvedByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockFile = {
  id: FILE_ID,
  companyId: COMPANY_ID,
  workspaceId: "00000000-0000-0000-0000-000000000002",
  path: "report.pdf",
  sizeBytes: 1024,
  contentType: "application/pdf",
  storageKey: "workspaces/xxx/files/yyy-report.pdf",
  checksum: "abc",
  uploadedByUserId: USER_ID,
  uploadedByAgentId: null,
  deletedAt: null,
  createdAt: new Date(),
};

const mockAttachment = {
  id: "00000000-0000-0000-0000-000000000060",
  companyId: COMPANY_ID,
  incidentId: INCIDENT_ID,
  workspaceFileId: FILE_ID,
  attachedByUserId: USER_ID,
  createdAt: new Date(),
};

// ----------------------------------------------------------------
// Mutable state
// ----------------------------------------------------------------
let deptFindFirst: typeof mockDept | null = mockDept;
let incidentFindFirst: typeof mockIncident | null = mockIncident;
let incidentFindMany: typeof mockIncident[] = [mockIncident];
let fileFindFirst: typeof mockFile | null = mockFile;
let attachmentFindFirst: typeof mockAttachment | null = null;
let attachmentFindMany: typeof mockAttachment[] = [];

const insertReturning = vi.fn(() => Promise.resolve([mockIncident] as unknown[]));
const updateReturning = vi.fn(() => Promise.resolve([mockIncident] as unknown[]));

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      departments: {
        findFirst: vi.fn(() => Promise.resolve(deptFindFirst)),
      },
      incidents: {
        findFirst: vi.fn(() => Promise.resolve(incidentFindFirst)),
        findMany: vi.fn(() => Promise.resolve(incidentFindMany)),
      },
      workspaceFiles: {
        findFirst: vi.fn(() => Promise.resolve(fileFindFirst)),
      },
      incidentAttachments: {
        findFirst: vi.fn(() => Promise.resolve(attachmentFindFirst)),
        findMany: vi.fn(() => Promise.resolve(attachmentFindMany)),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: insertReturning })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: updateReturning })),
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

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    eval: vi.fn().mockResolvedValue([1, Math.floor(Date.now() / 1000) - 30]),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ----------------------------------------------------------------
// Tests: POST (create incident)
// ----------------------------------------------------------------

describe("POST /api/departments/:deptId/incidents", () => {
  const app = createApp();

  beforeEach(() => {
    deptFindFirst = mockDept;
    insertReturning.mockResolvedValue([mockIncident]);
  });

  it("creates incident for operator and returns 201", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      [DEPT_ID]: "operator",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .post(`/api/departments/${DEPT_ID}/incidents`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "API down", description: "500 errors", severity: "high" });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
  });

  it("creates incident for oneops_admin", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .post(`/api/departments/${DEPT_ID}/incidents`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "API down", description: "500 errors", severity: "medium" });
    expect(res.status).toBe(201);
  });

  it("returns 403 for viewer (no incident:create)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      [DEPT_ID]: "viewer",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .post(`/api/departments/${DEPT_ID}/incidents`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "API down", description: "desc", severity: "low" });
    expect(res.status).toBe(403);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post(`/api/departments/${DEPT_ID}/incidents`)
      .send({ title: "x", description: "y", severity: "low" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid severity", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .post(`/api/departments/${DEPT_ID}/incidents`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "API down", description: "desc", severity: "catastrophic" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when department not found", async () => {
    deptFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .post(`/api/departments/00000000-0000-0000-0000-000000000099/incidents`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "API down", description: "desc", severity: "low" });
    expect(res.status).toBe(404);
  });
});

// ----------------------------------------------------------------
// Tests: GET list
// ----------------------------------------------------------------

describe("GET /api/departments/:deptId/incidents", () => {
  const app = createApp();

  beforeEach(() => {
    deptFindFirst = mockDept;
    incidentFindMany = [mockIncident];
  });

  it("returns paginated list for oneops_admin", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get(`/api/departments/${DEPT_ID}/incidents`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("page");
    expect(res.body).toHaveProperty("limit");
  });

  it("returns list for department viewer", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      [DEPT_ID]: "viewer",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .get(`/api/departments/${DEPT_ID}/incidents`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("returns list for customer_user (incident:view)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .get(`/api/departments/${DEPT_ID}/incidents`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/api/departments/${DEPT_ID}/incidents`);
    expect(res.status).toBe(401);
  });
});

// ----------------------------------------------------------------
// Tests: GET single
// ----------------------------------------------------------------

describe("GET /api/incidents/:id", () => {
  const app = createApp();

  beforeEach(() => {
    incidentFindFirst = mockIncident;
    attachmentFindMany = [];
  });

  it("returns incident with attachments for oneops_admin", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get(`/api/incidents/${INCIDENT_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(INCIDENT_ID);
    expect(res.body).toHaveProperty("attachments");
    expect(Array.isArray(res.body.attachments)).toBe(true);
  });

  it("returns 404 for non-existent incident", async () => {
    incidentFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get(`/api/incidents/00000000-0000-0000-0000-000000000099`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/api/incidents/${INCIDENT_ID}`);
    expect(res.status).toBe(401);
  });
});

// ----------------------------------------------------------------
// Tests: PATCH (status transitions + RBAC)
// ----------------------------------------------------------------

describe("PATCH /api/incidents/:id — status transitions", () => {
  const app = createApp();

  beforeEach(() => {
    incidentFindFirst = { ...mockIncident, status: "open" };
    updateReturning.mockResolvedValue([{ ...mockIncident, status: "investigating" }]);
  });

  it("operator can create/update non-status fields", async () => {
    incidentFindFirst = { ...mockIncident };
    updateReturning.mockResolvedValue([{ ...mockIncident, title: "Updated" }]);
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      [DEPT_ID]: "operator",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .patch(`/api/incidents/${INCIDENT_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Updated" });
    expect(res.status).toBe(200);
  });

  it("department_manager can transition open → investigating", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      [DEPT_ID]: "department_manager",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .patch(`/api/incidents/${INCIDENT_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "investigating" });
    expect(res.status).toBe(200);
  });

  it("oneops_admin can transition open → investigating", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .patch(`/api/incidents/${INCIDENT_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "investigating" });
    expect(res.status).toBe(200);
  });

  it("operator cannot transition open → investigating (no incident:manage)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      [DEPT_ID]: "operator",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .patch(`/api/incidents/${INCIDENT_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "investigating" });
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid status transition (open → closed)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .patch(`/api/incidents/${INCIDENT_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" });
    expect(res.status).toBe(400);
  });

  it("only oneops_admin can close a resolved incident", async () => {
    incidentFindFirst = { ...mockIncident, status: "resolved" };
    updateReturning.mockResolvedValue([{ ...mockIncident, status: "closed" }]);

    // department_manager cannot close
    const managerToken = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      [DEPT_ID]: "department_manager",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const managerRes = await request(app)
      .patch(`/api/incidents/${INCIDENT_ID}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "closed" });
    expect(managerRes.status).toBe(403);

    // oneops_admin can close
    const adminToken = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const adminRes = await request(app)
      .patch(`/api/incidents/${INCIDENT_ID}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "closed" });
    expect(adminRes.status).toBe(200);
  });

  it("viewer cannot update incidents", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      [DEPT_ID]: "viewer",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .patch(`/api/incidents/${INCIDENT_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Updated" });
    expect(res.status).toBe(403);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .patch(`/api/incidents/${INCIDENT_ID}`)
      .send({ status: "investigating" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent incident", async () => {
    incidentFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .patch(`/api/incidents/00000000-0000-0000-0000-000000000099`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "x" });
    expect(res.status).toBe(404);
  });
});

// ----------------------------------------------------------------
// Tests: POST attachments
// ----------------------------------------------------------------

describe("POST /api/incidents/:id/attachments", () => {
  const app = createApp();

  beforeEach(() => {
    incidentFindFirst = mockIncident;
    fileFindFirst = mockFile;
    attachmentFindFirst = null;
    insertReturning.mockResolvedValue([mockAttachment]);
  });

  it("attaches file for department_manager and returns 201", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      [DEPT_ID]: "department_manager",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .post(`/api/incidents/${INCIDENT_ID}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ workspaceFileId: FILE_ID });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
  });

  it("returns 403 for operator (no incident:manage)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      [DEPT_ID]: "operator",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .post(`/api/incidents/${INCIDENT_ID}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ workspaceFileId: FILE_ID });
    expect(res.status).toBe(403);
  });

  it("returns 409 when file already attached", async () => {
    attachmentFindFirst = mockAttachment;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .post(`/api/incidents/${INCIDENT_ID}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ workspaceFileId: FILE_ID });
    expect(res.status).toBe(409);
  });

  it("returns 404 when workspace file not found", async () => {
    fileFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .post(`/api/incidents/${INCIDENT_ID}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ workspaceFileId: FILE_ID });
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post(`/api/incidents/${INCIDENT_ID}/attachments`)
      .send({ workspaceFileId: FILE_ID });
    expect(res.status).toBe(401);
  });
});
