import * as OTPAuth from "otpauth";
import crypto from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { users, mfaRecoveryCodes } from "@agentops/db";
import { getEnv } from "../config/env.js";
import { getDb } from "../lib/db.js";
import { UnauthorizedError, ValidationError, ConflictError } from "../lib/errors.js";

const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_LENGTH = 10; // characters

// ----------------------------------------------------------------
// Encryption helpers for TOTP secret (AES-256-GCM)
// ----------------------------------------------------------------

function getEncryptionKey(): Buffer {
  const env = getEnv();
  const key = Buffer.from(env.MFA_ENCRYPTION_KEY, "utf8");
  // Pad or truncate to exactly 32 bytes
  const buf = Buffer.alloc(32);
  key.copy(buf, 0, 0, Math.min(key.length, 32));
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted secret format");
  const [ivHex, tagHex, dataHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString("utf8") + decipher.final("utf8");
}

// ----------------------------------------------------------------
// Recovery code helpers
// ----------------------------------------------------------------

function generateRecoveryCode(): string {
  // Generate a random alphanumeric code in groups: XXXXX-XXXXX
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // unambiguous chars
  let code = "";
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    if (i === 5) code += "-";
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.toUpperCase().replace("-", "")).digest("hex");
}

// ----------------------------------------------------------------
// MFA enrollment
// ----------------------------------------------------------------

export async function enrollMfa(
  userId: string,
  companyId: string,
): Promise<{ secret: string; uri: string; recoveryCodes: string[] }> {
  const db = getDb();
  const env = getEnv();

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new ValidationError("User not found");
  if (user.mfaEnabled) throw new ConflictError("MFA is already enabled for this account");

  // Generate TOTP secret
  const totp = new OTPAuth.TOTP({
    issuer: env.MFA_ISSUER,
    label: user.email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });

  const secretBase32 = totp.secret.base32;
  const uri = totp.toString();

  // Encrypt and persist the pending secret (not activated yet — verify step activates it)
  const encryptedSecret = encryptSecret(secretBase32);
  await db.update(users).set({ mfaSecret: encryptedSecret }).where(eq(users.id, userId));

  // Generate 8 recovery codes
  const recoveryCodes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    recoveryCodes.push(generateRecoveryCode());
  }

  // Delete any existing (unused) recovery codes and store new hashes
  await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await db.insert(mfaRecoveryCodes).values(
    recoveryCodes.map((code) => ({
      companyId,
      userId,
      codeHash: hashRecoveryCode(code),
    })),
  );

  return { secret: secretBase32, uri, recoveryCodes };
}

// ----------------------------------------------------------------
// MFA verify (activates MFA after enrollment)
// ----------------------------------------------------------------

export async function verifyMfaEnrollment(userId: string, code: string): Promise<void> {
  const db = getDb();

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new ValidationError("User not found");
  if (user.mfaEnabled) throw new ConflictError("MFA is already active");
  if (!user.mfaSecret) throw new ValidationError("No pending MFA enrollment. Call enroll first.");

  const secretBase32 = decryptSecret(user.mfaSecret);

  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) throw new UnauthorizedError("Invalid TOTP code");

  await db.update(users).set({ mfaEnabled: true }).where(eq(users.id, userId));
}

// ----------------------------------------------------------------
// MFA challenge (used during login when MFA is enabled)
// ----------------------------------------------------------------

export async function validateMfaCode(userId: string, code: string): Promise<void> {
  const db = getDb();

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.mfaEnabled || !user.mfaSecret) {
    throw new UnauthorizedError("MFA not configured for this account");
  }

  const secretBase32 = decryptSecret(user.mfaSecret);
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) throw new UnauthorizedError("Invalid TOTP code");
}

// ----------------------------------------------------------------
// MFA recover (use a recovery code to temporarily disable MFA)
// ----------------------------------------------------------------

export async function recoverMfa(userId: string, companyId: string, recoveryCode: string): Promise<void> {
  const db = getDb();

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new ValidationError("User not found");
  if (!user.mfaEnabled) throw new ValidationError("MFA is not enabled on this account");

  const normalizedHash = hashRecoveryCode(recoveryCode);

  const record = await db.query.mfaRecoveryCodes.findFirst({
    where: and(
      eq(mfaRecoveryCodes.userId, userId),
      eq(mfaRecoveryCodes.codeHash, normalizedHash),
      isNull(mfaRecoveryCodes.usedAt),
    ),
  });

  if (!record) throw new UnauthorizedError("Invalid or already-used recovery code");

  // Mark recovery code as used
  await db
    .update(mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(eq(mfaRecoveryCodes.id, record.id));

  // Temporarily disable MFA (clear secret + enabled flag)
  await db
    .update(users)
    .set({ mfaEnabled: false, mfaSecret: null })
    .where(eq(users.id, userId));

  // Invalidate remaining recovery codes
  await db
    .delete(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
}
