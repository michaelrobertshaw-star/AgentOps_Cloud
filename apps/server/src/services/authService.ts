import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import { users, sessions, companies, departmentMemberships } from "@agentops/db";
import type { UserRole, DepartmentRole, JwtPayload } from "@agentops/shared";
import { getEnv } from "../config/env.js";
import { getDb } from "../lib/db.js";
import { UnauthorizedError, ConflictError, ValidationError } from "../lib/errors.js";

function getSecret(): Uint8Array {
  return new TextEncoder().encode(getEnv().JWT_SECRET);
}

// Password hashing
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, getEnv().BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// JWT token management
export async function issueAccessToken(
  userId: string,
  companyId: string,
  roles: UserRole[],
  departmentRoles: Record<string, DepartmentRole>,
): Promise<string> {
  const env = getEnv();
  return new SignJWT({
    company_id: companyId,
    roles,
    department_roles: departmentRoles,
  } as unknown as JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`user:${userId}`)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.JWT_ACCESS_TOKEN_TTL}s`)
    .sign(getSecret());
}

export async function issueRefreshToken(
  userId: string,
  companyId: string,
): Promise<{ token: string; tokenId: string }> {
  const env = getEnv();
  const tokenId = crypto.randomUUID();
  const token = await new SignJWT({
    company_id: companyId,
    token_id: tokenId,
  } as unknown as JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`user:${userId}`)
    .setIssuer(env.JWT_ISSUER)
    .setExpirationTime(`${env.JWT_REFRESH_TOKEN_TTL}s`)
    .sign(getSecret());

  return { token, tokenId };
}

export async function verifyAccessToken(token: string): Promise<JwtPayload> {
  const env = getEnv();
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
  return payload as unknown as JwtPayload;
}

export async function verifyRefreshToken(
  token: string,
): Promise<{ sub: string; company_id: string; token_id: string }> {
  const env = getEnv();
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: env.JWT_ISSUER,
  });
  return payload as unknown as { sub: string; company_id: string; token_id: string };
}

// User registration (company + admin user)
export async function registerCompanyAndUser(input: {
  companyName: string;
  companyDisplayName: string;
  email: string;
  name: string;
  password: string;
}) {
  const db = getDb();

  if (input.password.length < 8) {
    throw new ValidationError("Password must be at least 8 characters");
  }

  // Check for existing company name
  const existingCompany = await db.query.companies.findFirst({
    where: eq(companies.name, input.companyName),
  });
  if (existingCompany) {
    throw new ConflictError(`Company name '${input.companyName}' is already taken`);
  }

  // Check for existing email globally
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, input.email),
  });
  if (existingUser) {
    throw new ConflictError("Email is already registered");
  }

  const passwordHash = await hashPassword(input.password);

  // Create company
  const [company] = await db
    .insert(companies)
    .values({
      name: input.companyName,
      displayName: input.companyDisplayName,
    })
    .returning();

  // Create admin user
  const [user] = await db
    .insert(users)
    .values({
      companyId: company.id,
      email: input.email,
      name: input.name,
      passwordHash,
      role: "company_admin",
      status: "active",
    })
    .returning();

  return { company, user };
}

// Login
export async function login(email: string, password: string) {
  const db = getDb();

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!user || !user.passwordHash) {
    throw new UnauthorizedError("Invalid email or password");
  }

  if (user.status !== "active") {
    throw new UnauthorizedError("Account is not active");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError("Invalid email or password");
  }

  // Get department roles
  const memberships = await db.query.departmentMemberships.findMany({
    where: eq(departmentMemberships.userId, user.id),
  });

  const departmentRoles: Record<string, DepartmentRole> = {};
  for (const m of memberships) {
    departmentRoles[m.departmentId] = m.role;
  }

  const accessToken = await issueAccessToken(
    user.id,
    user.companyId,
    [user.role] as UserRole[],
    departmentRoles,
  );
  const { token: refreshToken, tokenId } = await issueRefreshToken(user.id, user.companyId);

  // Create session
  const tokenHash = crypto.createHash("sha256").update(tokenId).digest("hex");
  const env = getEnv();
  await db.insert(sessions).values({
    companyId: user.companyId,
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + env.JWT_REFRESH_TOKEN_TTL * 1000),
  });

  // Update last login
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    accessToken,
    refreshToken,
  };
}

// Refresh token
export async function refreshAccessToken(refreshTokenStr: string) {
  const payload = await verifyRefreshToken(refreshTokenStr).catch(() => {
    throw new UnauthorizedError("Invalid refresh token");
  });

  const userId = payload.sub.replace("user:", "");
  const db = getDb();

  // Verify session exists
  const tokenHash = crypto.createHash("sha256").update(payload.token_id).digest("hex");
  const session = await db.query.sessions.findFirst({
    where: and(eq(sessions.tokenHash, tokenHash), eq(sessions.userId, userId)),
  });

  if (!session || session.expiresAt < new Date()) {
    throw new UnauthorizedError("Session expired or revoked");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user || user.status !== "active") {
    throw new UnauthorizedError("Account is not active");
  }

  // Get department roles
  const memberships = await db.query.departmentMemberships.findMany({
    where: eq(departmentMemberships.userId, user.id),
  });

  const departmentRoles: Record<string, DepartmentRole> = {};
  for (const m of memberships) {
    departmentRoles[m.departmentId] = m.role;
  }

  const accessToken = await issueAccessToken(
    user.id,
    user.companyId,
    [user.role] as UserRole[],
    departmentRoles,
  );

  // Update session activity
  await db
    .update(sessions)
    .set({ lastActiveAt: new Date() })
    .where(eq(sessions.id, session.id));

  return { accessToken };
}

// Logout (invalidate session)
export async function logout(refreshTokenStr: string) {
  const payload = await verifyRefreshToken(refreshTokenStr).catch(() => {
    // Silently handle invalid tokens on logout
    return null;
  });

  if (!payload) return;

  const tokenHash = crypto.createHash("sha256").update(payload.token_id).digest("hex");
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}
