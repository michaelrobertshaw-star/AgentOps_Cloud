/**
 * Integration tests for M4.7: Session management endpoints.
 *
 * GET  /api/auth/sessions         — list active sessions
 * DELETE /api/auth/sessions/:id   — revoke specific session
 * DELETE /api/auth/sessions       — revoke all (optionally keeping one)
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
const SESSION_ID = "00000000-0000-0000-0000-000000000099";
const SESSION_ID_2 = "00000000-0000-0000-0000-000000000098";

const mockSession = {
  id: SESSION_ID,
  companyId: COMPANY_ID,
  userId: USER_ID,
  tokenHash: "abc123",
  ipAddress: "127.0.0.1",
  userAgent: "Mozilla/5.0",
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000), // 7 days from now
  createdAt: new Date(),
  lastActiveAt: new Date(),
};

const mockSession2 = {
  ...mockSession,
  id: SESSION_ID_2,
  tokenHash: "def456",
};

// ----------------------------------------------------------------
// Mutable state
// ----------------------------------------------------------------
let sessionFindFirst: typeof mockSession | null = mockSession;
let sessionFindMany: typeof mockSession[] = [mockSession];

const deleteMock = vi.fn(() => Promise.resolve());
const updateReturning = vi.fn(() => Promise.resolve([mockSession]));

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      sessions: {
        findFirst: vi.fn(() => Promise.resolve(sessionFindFirst)),
        findMany: vi.fn(() => Promise.resolve(sessionFindMany)),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: updateReturning })),
      })),
    })),
    delete: vi.fn(() => ({
      where: deleteMock,
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
    set: vi.fn().mockResolvedValue("OK"),
    expire: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(1), // sessions are "alive" in Redis by default
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ----------------------------------------------------------------
// Tests: GET /api/auth/sessions
// ----------------------------------------------------------------

describe("GET /api/auth/sessions", () => {
  const app = createApp();

  beforeEach(() => {
    sessionFindMany = [mockSession];
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/auth/sessions");
    expect(res.status).toBe(401);
  });

  it("returns session list for authenticated user", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessions");
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0]).toHaveProperty("id", SESSION_ID);
    expect(res.body.sessions[0]).toHaveProperty("ipAddress");
    expect(res.body.sessions[0]).toHaveProperty("userAgent");
    expect(res.body.sessions[0]).toHaveProperty("createdAt");
    expect(res.body.sessions[0]).toHaveProperty("lastActiveAt");
    expect(res.body.sessions[0]).toHaveProperty("expiresAt");
  });

  it("returns empty list when user has no sessions", async () => {
    sessionFindMany = [];
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(0);
  });
});

// ----------------------------------------------------------------
// Tests: DELETE /api/auth/sessions/:id
// ----------------------------------------------------------------

describe("DELETE /api/auth/sessions/:id", () => {
  const app = createApp();

  beforeEach(() => {
    sessionFindFirst = mockSession;
    deleteMock.mockResolvedValue(undefined);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).delete(`/api/auth/sessions/${SESSION_ID}`);
    expect(res.status).toBe(401);
  });

  it("revokes an existing session and returns 200", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .delete(`/api/auth/sessions/${SESSION_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("message");
  });

  it("returns 404 when session is not found", async () => {
    sessionFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .delete(`/api/auth/sessions/${SESSION_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("returns 404 when session belongs to another user", async () => {
    sessionFindFirst = { ...mockSession, userId: "other-user" };
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .delete(`/api/auth/sessions/${SESSION_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ----------------------------------------------------------------
// Tests: DELETE /api/auth/sessions
// ----------------------------------------------------------------

describe("DELETE /api/auth/sessions", () => {
  const app = createApp();

  beforeEach(() => {
    sessionFindMany = [mockSession, mockSession2];
    deleteMock.mockResolvedValue(undefined);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).delete("/api/auth/sessions");
    expect(res.status).toBe(401);
  });

  it("revokes all sessions and returns count", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .delete("/api/auth/sessions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("count", 2);
    expect(res.body.message).toContain("2 session(s) revoked");
  });

  it("revokes all sessions except the specified one", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .delete("/api/auth/sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ exceptSessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("count", 1);
  });

  it("returns 0 when user has no sessions", async () => {
    sessionFindMany = [];
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["oneops_admin"], {});
    const res = await request(app)
      .delete("/api/auth/sessions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
});
