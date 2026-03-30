import { describe, it, expect, vi, beforeEach } from "vitest";
import * as OTPAuth from "otpauth";
import { encryptSecret, decryptSecret } from "./mfaService.js";

// ---------------------------------------------------------------------------
// Top-level DB mock (hoisted by vitest)
// ---------------------------------------------------------------------------
const mockFindFirstUser = vi.fn();
const mockFindFirstRecovery = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockInsertValues = vi.fn();
const mockDeleteWhere = vi.fn();

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      users: { findFirst: mockFindFirstUser },
      mfaRecoveryCodes: { findFirst: mockFindFirstRecovery },
    },
    update: vi.fn(() => ({ set: mockUpdateSet })),
    insert: vi.fn(() => ({ values: mockInsertValues })),
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
  }),
}));

// ---------------------------------------------------------------------------
// Encryption round-trip tests (no DB required)
// ---------------------------------------------------------------------------
describe("mfaService — encryption", () => {
  it("encrypts and decrypts a secret correctly", () => {
    const original = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptSecret(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted.split(":")).toHaveLength(3); // iv:tag:ciphertext

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(original);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const enc1 = encryptSecret(secret);
    const enc2 = encryptSecret(secret);
    expect(enc1).not.toBe(enc2);
    expect(decryptSecret(enc1)).toBe(secret);
    expect(decryptSecret(enc2)).toBe(secret);
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptSecret("JBSWY3DPEHPK3PXP");
    const parts = encrypted.split(":");
    parts[2] = "deadbeef";
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("throws on invalid format", () => {
    expect(() => decryptSecret("notavalidformat")).toThrow("Invalid encrypted secret format");
  });
});

// ---------------------------------------------------------------------------
// TOTP validation tests (no DB required)
// ---------------------------------------------------------------------------
describe("mfaService — TOTP validation", () => {
  it("validates a fresh TOTP code correctly", () => {
    const totp = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      issuer: "TestIssuer",
      label: "test@example.com",
    });

    const secretBase32 = totp.secret.base32;
    const code = totp.generate();

    const verifier = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });

    const delta = verifier.validate({ token: code, window: 1 });
    expect(delta).not.toBeNull();
  });

  it("roundtrips secret through encryption and still validates", () => {
    const totp = new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30 });
    const originalBase32 = totp.secret.base32;

    const encrypted = encryptSecret(originalBase32);
    const decrypted = decryptSecret(encrypted);

    const verifier = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(decrypted),
    });

    const code = totp.generate();
    const delta = verifier.validate({ token: code, window: 1 });
    expect(delta).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enrollMfa — with mocked DB
// ---------------------------------------------------------------------------
describe("mfaService — enrollMfa", () => {
  const mockUserId = "user-test-123";
  const mockCompanyId = "company-test-456";

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSet.mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    mockInsertValues.mockResolvedValue([]);
    mockDeleteWhere.mockResolvedValue([]);
  });

  it("generates a valid TOTP URI, base32 secret, and 8 recovery codes", async () => {
    mockFindFirstUser.mockResolvedValue({
      id: mockUserId,
      companyId: mockCompanyId,
      email: "user@example.com",
      mfaEnabled: false,
      mfaSecret: null,
    });

    const { enrollMfa } = await import("./mfaService.js");
    const result = await enrollMfa(mockUserId, mockCompanyId);

    expect(result.secret).toBeTruthy();
    expect(result.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(Array.isArray(result.recoveryCodes)).toBe(true);
    expect(result.recoveryCodes).toHaveLength(8);
    expect(result.recoveryCodes[0]).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect(mockInsertValues).toHaveBeenCalled();
  });

  it("throws ConflictError if MFA is already enabled", async () => {
    mockFindFirstUser.mockResolvedValue({
      id: mockUserId,
      companyId: mockCompanyId,
      email: "user@example.com",
      mfaEnabled: true,
      mfaSecret: "existing-secret",
    });

    const { enrollMfa } = await import("./mfaService.js");
    const { ConflictError } = await import("../lib/errors.js");

    await expect(enrollMfa(mockUserId, mockCompanyId)).rejects.toThrow(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// verifyMfaEnrollment — with mocked DB
// ---------------------------------------------------------------------------
describe("mfaService — verifyMfaEnrollment", () => {
  const mockUserId = "user-test-123";

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSet.mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  });

  it("activates MFA with a valid TOTP code", async () => {
    const totp = new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30 });
    const secretBase32 = totp.secret.base32;

    mockFindFirstUser.mockResolvedValue({
      id: mockUserId,
      mfaEnabled: false,
      mfaSecret: encryptSecret(secretBase32),
    });

    const { verifyMfaEnrollment } = await import("./mfaService.js");
    const code = totp.generate();

    await expect(verifyMfaEnrollment(mockUserId, code)).resolves.toBeUndefined();
    expect(mockUpdateSet).toHaveBeenCalled();
  });

  it("throws ValidationError if no pending mfaSecret", async () => {
    mockFindFirstUser.mockResolvedValue({
      id: mockUserId,
      mfaEnabled: false,
      mfaSecret: null,
    });

    const { verifyMfaEnrollment } = await import("./mfaService.js");
    const { ValidationError } = await import("../lib/errors.js");

    await expect(verifyMfaEnrollment(mockUserId, "123456")).rejects.toThrow(ValidationError);
  });
});
