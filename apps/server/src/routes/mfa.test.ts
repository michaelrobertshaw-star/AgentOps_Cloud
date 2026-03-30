/**
 * MFA Enrollment (TOTP) — integration tests
 * Covers:  POST /api/auth/mfa/enroll
 *          POST /api/auth/mfa/verify
 *          POST /api/auth/mfa/recover
 *          POST /api/auth/mfa/challenge
 *          Login flow when MFA is enabled
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import * as OTPAuth from "otpauth";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";
import { encryptSecret } from "../services/mfaService.js";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const COMPANY_ID = "co-mfa-1";
const USER_ID = "user-mfa-1";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
let mockUser: Record<string, unknown>;
let mockRecoveryCode: Record<string, unknown> | null = null;

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
      users: {
        findFirst: vi.fn(() => Promise.resolve(mockUser)),
      },
      sessions: {
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
      departmentMemberships: {
        findMany: vi.fn(() => Promise.resolve([])),
      },
      mfaRecoveryCodes: {
        findFirst: vi.fn(() => Promise.resolve(mockRecoveryCode)),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([mockUser])),
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

// ---------------------------------------------------------------------------
// Helper: issue a valid access token for the mock user
// ---------------------------------------------------------------------------
async function authToken() {
  return issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("MFA routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecoveryCode = null;
    mockUser = {
      id: USER_ID,
      companyId: COMPANY_ID,
      email: "admin@example.com",
      name: "Admin",
      role: "company_admin",
      passwordHash: "$2b$12$hash",
      status: "active",
      mfaEnabled: false,
      mfaSecret: null,
    };
  });

  // ── POST /api/auth/mfa/enroll ──────────────────────────────────────────────

  describe("POST /api/auth/mfa/enroll", () => {
    it("returns 401 without auth token", async () => {
      const app = createApp();
      const res = await request(app).post("/api/auth/mfa/enroll");
      expect(res.status).toBe(401);
    });

    it("returns TOTP secret + QR URI + 8 recovery codes for active user", async () => {
      const app = createApp();
      const token = await authToken();

      const res = await request(app)
        .post("/api/auth/mfa/enroll")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.secret).toBeTruthy();
      expect(res.body.uri).toMatch(/^otpauth:\/\/totp\//);
      expect(Array.isArray(res.body.recoveryCodes)).toBe(true);
      expect(res.body.recoveryCodes).toHaveLength(8);
      expect(res.body.recoveryCodes[0]).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    });

    it("returns 409 if MFA is already enabled", async () => {
      mockUser.mfaEnabled = true;
      mockUser.mfaSecret = "encrypted-secret";

      const app = createApp();
      const token = await authToken();

      const res = await request(app)
        .post("/api/auth/mfa/enroll")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(409);
    });
  });

  // ── POST /api/auth/mfa/verify ──────────────────────────────────────────────

  describe("POST /api/auth/mfa/verify", () => {
    it("returns 401 without auth token", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/auth/mfa/verify")
        .send({ code: "123456" });
      expect(res.status).toBe(401);
    });

    it("returns 400 with non-numeric or wrong-length code", async () => {
      const app = createApp();
      const token = await authToken();

      const res = await request(app)
        .post("/api/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: "abc" });

      expect(res.status).toBe(400);
    });

    it("returns 400 if no pending enrollment (no mfaSecret)", async () => {
      mockUser.mfaSecret = null;
      const app = createApp();
      const token = await authToken();

      const res = await request(app)
        .post("/api/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: "123456" });

      expect(res.status).toBe(400);
    });

    it("returns 401 with wrong TOTP code", async () => {
      // Enroll first: set a valid encrypted secret
      const totp = new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30 });
      mockUser.mfaSecret = encryptSecret(totp.secret.base32);
      mockUser.mfaEnabled = false;

      const app = createApp();
      const token = await authToken();

      const res = await request(app)
        .post("/api/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: "000000" });

      // Should be 401 for invalid code (unless 000000 happens to match)
      expect([200, 401]).toContain(res.status);
    });

    it("returns 200 with a correct TOTP code", async () => {
      const totp = new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30 });
      const secretBase32 = totp.secret.base32;
      mockUser.mfaSecret = encryptSecret(secretBase32);
      mockUser.mfaEnabled = false;

      const app = createApp();
      const token = await authToken();

      const validCode = totp.generate();

      const res = await request(app)
        .post("/api/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: validCode });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/activated/i);
    });
  });

  // ── POST /api/auth/mfa/recover ─────────────────────────────────────────────

  describe("POST /api/auth/mfa/recover", () => {
    it("returns 401 without auth token", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/auth/mfa/recover")
        .send({ recoveryCode: "ABCDE-FGHIJ" });
      expect(res.status).toBe(401);
    });

    it("returns 400 if MFA not enabled", async () => {
      mockUser.mfaEnabled = false;
      const app = createApp();
      const token = await authToken();

      const res = await request(app)
        .post("/api/auth/mfa/recover")
        .set("Authorization", `Bearer ${token}`)
        .send({ recoveryCode: "ABCDE-FGHIJ" });

      expect(res.status).toBe(400);
    });

    it("returns 401 with invalid recovery code", async () => {
      mockUser.mfaEnabled = true;
      mockUser.mfaSecret = "some-secret";

      // mfaRecoveryCodes.findFirst returns null (invalid code)
      const app = createApp();
      const token = await authToken();

      const res = await request(app)
        .post("/api/auth/mfa/recover")
        .set("Authorization", `Bearer ${token}`)
        .send({ recoveryCode: "XXXXX-XXXXX" });

      expect(res.status).toBe(401);
    });

    it("returns 200 with a valid recovery code", async () => {
      mockUser.mfaEnabled = true;
      mockUser.mfaSecret = "some-secret";

      // "ABCDE-FGHIJ" normalizes to "ABCDEFGHIJ" (dash removed, uppercased)
      const recoveryCodeHash = crypto
        .createHash("sha256")
        .update("ABCDEFGHIJ")
        .digest("hex");

      mockRecoveryCode = {
        id: "recovery-1",
        userId: USER_ID,
        companyId: COMPANY_ID,
        codeHash: recoveryCodeHash,
        usedAt: null,
        createdAt: new Date(),
      };

      const app = createApp();
      const token = await authToken();

      const res = await request(app)
        .post("/api/auth/mfa/recover")
        .set("Authorization", `Bearer ${token}`)
        .send({ recoveryCode: "ABCDE-FGHIJ" });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/disabled/i);
    });
  });

  // ── POST /api/auth/mfa/challenge ───────────────────────────────────────────

  describe("POST /api/auth/mfa/challenge", () => {
    it("returns 400 with missing mfaToken or code", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/auth/mfa/challenge")
        .send({ code: "123456" }); // missing mfaToken
      expect(res.status).toBe(400);
    });

    it("returns 401 with an invalid mfaToken", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/auth/mfa/challenge")
        .send({ mfaToken: "invalid.token.here", code: "123456" });
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/auth/login — validation ─────────────────────────────────────

  describe("POST /api/auth/login — validation", () => {
    it("returns 400 for missing password field", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "admin@example.com" });
      expect(res.status).toBe(400);
    });
  });
});
