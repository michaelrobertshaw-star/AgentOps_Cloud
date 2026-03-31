/**
 * Integration tests for M3.8: Audit log query endpoints.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------
const COMPANY_ID = "co-1";
const USER_ID = "user-1";

const makeLog = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  companyId: COMPANY_ID,
  actorType: "user" as const,
  actorId: USER_ID,
  action: "department:create",
  resourceType: "department",
  resourceId: "dept-1",
  departmentId: null,
  context: {},
  changes: null,
  outcome: "success" as const,
  riskLevel: "low" as const,
  ipAddress: null,
  userAgent: null,
  requestId: null,
  entryHash: "a".repeat(64),
  createdAt: new Date(),
  ...overrides,
});

const LOG1 = makeLog("00000000-0000-0000-0000-000000000080");
const LOG2 = makeLog("00000000-0000-0000-0000-000000000081", {
  action: "incident:create",
  resourceType: "incident",
});

// ----------------------------------------------------------------
// Mutable state
// ----------------------------------------------------------------
let logFindMany: ReturnType<typeof makeLog>[] = [LOG1, LOG2];

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      auditLogs: {
        findMany: vi.fn(() => Promise.resolve(logFindMany)),
      },
    },
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
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
// Tests: GET list
// ----------------------------------------------------------------

describe("GET /api/companies/:companyId/audit-logs", () => {
  const app = createApp();

  beforeEach(() => {
    logFindMany = [LOG1, LOG2];
  });

  it("returns paginated log list for oneops_admin", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty("nextCursor");
    expect(res.body).toHaveProperty("total");
  });

  it("returns log list for customer_user role", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("returns 403 for operator (no audit:view)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, [], {
      "dept-1": "operator",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 when accessing another company", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get(`/api/companies/other-company/audit-logs`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/audit-logs`);
    expect(res.status).toBe(401);
  });

  it("filters by action", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs?action=incident:create`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Only LOG2 matches action=incident:create
    expect(res.body.data.every((l: { action: string }) => l.action === "incident:create")).toBe(true);
  });

  it("filters by entityType (resourceType alias)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs?entityType=incident`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  it("filters by actorId", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs?actorId=${USER_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("respects limit parameter", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs?limit=1`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.nextCursor).not.toBeNull();
  });

  it("cursor-based pagination returns next page", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    // First page
    const page1 = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs?limit=1`)
      .set("Authorization", `Bearer ${token}`);
    expect(page1.status).toBe(200);
    const cursor = page1.body.nextCursor;

    // Second page using cursor
    const page2 = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs?limit=1&cursor=${cursor}`)
      .set("Authorization", `Bearer ${token}`);
    expect(page2.status).toBe(200);
    // Second page should have different items than first
    const page1Ids = page1.body.data.map((l: { id: string }) => l.id);
    const page2Ids = page2.body.data.map((l: { id: string }) => l.id);
    expect(page2Ids.some((id: string) => !page1Ids.includes(id))).toBe(true);
  });
});

// ----------------------------------------------------------------
// Tests: GET verify
// ----------------------------------------------------------------

describe("GET /api/companies/:companyId/audit-logs/verify", () => {
  const app = createApp();

  beforeEach(() => {
    logFindMany = [LOG1, LOG2];
  });

  it("returns ok=true when all hashes are valid", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs/verify`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.firstCorruptId).toBeNull();
    expect(res.body.verifiedCount).toBe(2);
  });

  it("returns ok=false with firstCorruptId when hash is invalid", async () => {
    logFindMany = [
      LOG1,
      makeLog("00000000-0000-0000-0000-000000000081", { entryHash: "invalid-hash" }),
    ];
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit-logs/verify`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.firstCorruptId).toBe("00000000-0000-0000-0000-000000000081");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/audit-logs/verify`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for another company", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["customer_user"], {});
    const res = await request(app)
      .get(`/api/companies/other-company/audit-logs/verify`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
