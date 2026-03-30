/**
 * API Key Rotation — integration tests
 * Covers:  POST /api/agents/:id/keys/rotate (bulk)
 *          POST /api/agents/:id/keys/:keyId/rotate (with grace period)
 *          POST /api/agents/:id/keys/force-revoke-all
 *          Dual-key JWT verification
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken, issueAgentRunToken, verifyAgentRunToken } from "../services/authService.js";
import { issueAgentRunToken as issueAgentToken, verifyAgentRunToken as verifyAgentToken } from "../services/agentAuthService.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const COMPANY_ID = "co-rotation-1";
const USER_ID = "user-rotation-1";
const AGENT_ID = "agent-rotation-1";
const KEY_ID = "key-rotation-1";
const KEY_HASH = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1"; // 64 hex

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
let mockAgent: Record<string, unknown> | null;
let mockActiveKeys: Record<string, unknown>[];

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
      agents: {
        findFirst: vi.fn(() => Promise.resolve(mockAgent)),
      },
      agentApiKeys: {
        findFirst: vi.fn(() => Promise.resolve(mockActiveKeys[0] ?? null)),
        findMany: vi.fn(() => Promise.resolve(mockActiveKeys)),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
            {
              id: "new-key-id",
              companyId: COMPANY_ID,
              agentId: AGENT_ID,
              keyHash: "newhash" + "0".repeat(58),
              keyPrefix: "ak_newpref",
              name: "default",
              status: "active",
              expiresAt: null,
              validUntil: null,
              revokedAt: null,
              lastUsedAt: null,
              createdAt: new Date(),
            },
          ]),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  }),
}));

async function adminToken() {
  return issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("API Key Rotation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent = {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "test-agent",
      status: "active",
      departmentId: null,
    };
    mockActiveKeys = [
      {
        id: KEY_ID,
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        keyHash: KEY_HASH,
        keyPrefix: "ak_abc123",
        name: "default",
        status: "active",
        expiresAt: null,
        validUntil: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
      },
    ];
  });

  // ── POST /api/agents/:id/keys/:keyId/rotate ────────────────────────────────

  describe("POST /api/agents/:id/keys/:keyId/rotate", () => {
    it("returns 401 without auth", async () => {
      const app = createApp();
      const res = await request(app).post(`/api/agents/${AGENT_ID}/keys/${KEY_ID}/rotate`);
      expect(res.status).toBe(401);
    });

    it("returns 201 with new key and grace period info", async () => {
      const app = createApp();
      const token = await adminToken();

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys/${KEY_ID}/rotate`)
        .set("Authorization", `Bearer ${token}`)
        .send({ gracePeriodHours: 24 });

      expect(res.status).toBe(201);
      expect(res.body.key).toMatch(/^ak_/);
      expect(res.body.revokedKeyId).toBe(KEY_ID);
      expect(res.body.gracePeriodEnds).toBeTruthy();
    });

    it("returns 409 if key is already revoked", async () => {
      mockActiveKeys[0].status = "revoked";
      const app = createApp();
      const token = await adminToken();

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys/${KEY_ID}/rotate`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(409);
    });
  });

  // ── POST /api/agents/:id/keys/rotate ──────────────────────────────────────

  describe("POST /api/agents/:id/keys/rotate (bulk)", () => {
    it("returns 401 without auth", async () => {
      const app = createApp();
      const res = await request(app).post(`/api/agents/${AGENT_ID}/keys/rotate`);
      expect(res.status).toBe(401);
    });

    it("rotates all active keys and returns new key", async () => {
      const app = createApp();
      const token = await adminToken();

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys/rotate`)
        .set("Authorization", `Bearer ${token}`)
        .send({ gracePeriodHours: 12 });

      expect(res.status).toBe(201);
      expect(res.body.key).toMatch(/^ak_/);
      expect(Array.isArray(res.body.rotatedKeyIds)).toBe(true);
      expect(res.body.rotatedKeyIds).toContain(KEY_ID);
      expect(res.body.gracePeriodEnds).toBeTruthy();
    });

    it("returns 409 when agent has no active keys", async () => {
      mockActiveKeys = [];
      const app = createApp();
      const token = await adminToken();

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys/rotate`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(409);
    });
  });

  // ── POST /api/agents/:id/keys/force-revoke-all ────────────────────────────

  describe("POST /api/agents/:id/keys/force-revoke-all", () => {
    it("returns 401 without auth", async () => {
      const app = createApp();
      const res = await request(app).post(`/api/agents/${AGENT_ID}/keys/force-revoke-all`);
      expect(res.status).toBe(401);
    });

    it("revokes all active keys immediately", async () => {
      const app = createApp();
      const token = await adminToken();

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys/force-revoke-all`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.revokedCount).toBe(1);
      expect(Array.isArray(res.body.revokedKeyIds)).toBe(true);
    });

    it("returns 0 revoked when no active keys", async () => {
      mockActiveKeys = [];
      const app = createApp();
      const token = await adminToken();

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys/force-revoke-all`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.revokedCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Dual-key JWT verification
// ---------------------------------------------------------------------------
describe("agentAuthService — dual-key JWT verification", () => {
  it("verifies a token signed with the primary secret", async () => {
    const token = await issueAgentToken("agent-1", "co-1", "dept-1", "test-agent");
    const payload = await verifyAgentToken(token);
    expect(payload.sub).toBe("agent:agent-1");
  });

  it("rejects a token with an unknown secret (no secondary configured)", async () => {
    // By default JWT_SECRET_SECONDARY is not set — should fail on unknown token
    const token = await issueAgentToken("agent-1", "co-1", null, "test-agent");
    const tampered = token.slice(0, -5) + "XXXXX";
    await expect(verifyAgentToken(tampered)).rejects.toThrow();
  });
});
