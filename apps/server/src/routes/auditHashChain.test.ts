/**
 * Audit Hash Chain & Archive routes — integration tests
 * Covers:  GET  /api/companies/:id/audit/verify-chain
 *          POST /api/companies/:id/audit/archive
 *          GET  /api/companies/:id/audit/archived
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const COMPANY_ID = "co-hashchain-1";
const USER_ID = "user-hashchain-1";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue([1, Math.floor(Date.now() / 1000) - 30]),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
  })),
}));

vi.mock("../middleware/audit.js", () => ({
  auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => {
    (_req as { audit: () => Promise<void> }).audit = async () => {};
    next();
  },
}));

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      auditLogs: {
        findMany: vi.fn(() => Promise.resolve([])),
      },
      companies: {
        findFirst: vi.fn(() =>
          Promise.resolve({
            id: COMPANY_ID,
            auditRetentionDays: 90,
          }),
        ),
      },
    },
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  }),
}));

// Mock auditArchiveService so tests don't need Redis or S3
let mockJobId = "mock-job-id-1";
let mockArchives: Array<{ key: string; size: number; lastModified: Date }> = [];

vi.mock("../services/auditArchiveService.js", () => ({
  enqueueVerifyChain: vi.fn(async () => mockJobId),
  enqueueArchive: vi.fn(async () => mockJobId),
  listAuditArchives: vi.fn(async () => mockArchives),
  getAuditQueue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue({ id: mockJobId }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function adminToken() {
  return issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
}
async function auditorToken() {
  return issueAccessToken(USER_ID, COMPANY_ID, ["auditor"], {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GET /api/companies/:id/audit/verify-chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJobId = "mock-job-id-1";
    mockArchives = [];
  });

  it("returns 401 without auth", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/audit/verify-chain`);
    expect(res.status).toBe(401);
  });

  it("returns 202 with jobId for company_admin", async () => {
    const app = createApp();
    const token = await adminToken();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit/verify-chain`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe("mock-job-id-1");
    expect(res.body.message).toMatch(/enqueued/i);
  });

  it("returns 202 with jobId for auditor", async () => {
    const app = createApp();
    const token = await auditorToken();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit/verify-chain`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(202);
  });

  it("returns 403 when accessing another company", async () => {
    const app = createApp();
    const token = await adminToken();

    const res = await request(app)
      .get(`/api/companies/other-company/audit/verify-chain`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe("POST /api/companies/:id/audit/archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJobId = "mock-job-id-2";
  });

  it("returns 401 without auth", async () => {
    const app = createApp();
    const res = await request(app).post(`/api/companies/${COMPANY_ID}/audit/archive`);
    expect(res.status).toBe(401);
  });

  it("returns 202 with jobId for company_admin", async () => {
    const app = createApp();
    const token = await adminToken();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/audit/archive`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe("mock-job-id-2");
  });

  it("returns 403 for auditor (lacks audit:manage)", async () => {
    const app = createApp();
    const token = await auditorToken();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/audit/archive`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("returns 403 when accessing another company", async () => {
    const app = createApp();
    const token = await adminToken();

    const res = await request(app)
      .post(`/api/companies/other-company/audit/archive`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe("GET /api/companies/:id/audit/archived", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockArchives = [];
  });

  it("returns 401 without auth", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/audit/archived`);
    expect(res.status).toBe(401);
  });

  it("returns empty list when no archives exist", async () => {
    const app = createApp();
    const token = await auditorToken();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit/archived`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.archives)).toBe(true);
    expect(res.body.archives).toHaveLength(0);
  });

  it("returns archive list for company_admin", async () => {
    mockArchives = [
      {
        key: `${COMPANY_ID}/archive-2024-01-01-1234567890.ndjson.gz`,
        size: 4096,
        lastModified: new Date("2024-01-01T12:00:00Z"),
      },
    ];

    const app = createApp();
    const token = await adminToken();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/audit/archived`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.archives).toHaveLength(1);
    expect(res.body.archives[0].key).toContain("archive-2024-01-01");
    expect(res.body.archives[0].size).toBe(4096);
  });

  it("returns 403 when accessing another company", async () => {
    const app = createApp();
    const token = await adminToken();

    const res = await request(app)
      .get(`/api/companies/other-company/audit/archived`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
