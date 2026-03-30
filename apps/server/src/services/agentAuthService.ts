import { SignJWT, jwtVerify } from "jose";
import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import { agents, agentApiKeys } from "@agentops/db";
import { getDb } from "../lib/db.js";
import { getEnv } from "../config/env.js";
import { UnauthorizedError } from "../lib/errors.js";

export interface AgentRunToken {
  sub: string; // "agent:<agent_id>"
  company_id: string;
  department_id: string | null;
  agent_name: string;
  scope: "task_execution";
  iat: number;
  exp: number;
  iss: string;
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(getEnv().JWT_SECRET);
}

function getSecondarySecret(): Uint8Array | null {
  const secondary = getEnv().JWT_SECRET_SECONDARY;
  if (!secondary) return null;
  return new TextEncoder().encode(secondary);
}

/**
 * Verify a raw API key against stored hashes and return the matching agent.
 * Supports rotated keys still within their grace period (valid_until).
 */
export async function authenticateAgent(rawApiKey: string) {
  const db = getDb();

  // Derive hash from key to look up
  const keyHash = crypto.createHash("sha256").update(rawApiKey).digest("hex");

  const apiKey = await db.query.agentApiKeys.findFirst({
    where: and(eq(agentApiKeys.keyHash, keyHash), eq(agentApiKeys.status, "active")),
  });

  if (!apiKey) {
    // Check if this is a recently-rotated key still within its grace period
    const gracePeriodKey = await db.query.agentApiKeys.findFirst({
      where: and(eq(agentApiKeys.keyHash, keyHash), eq(agentApiKeys.status, "revoked")),
    });
    if (gracePeriodKey?.validUntil && gracePeriodKey.validUntil > new Date()) {
      // Allow access during grace period — treat as if still active for auth purposes
      const agent = await db.query.agents.findFirst({
        where: eq(agents.id, gracePeriodKey.agentId),
      });
      if (!agent || !["active", "testing", "degraded"].includes(agent.status)) {
        throw new UnauthorizedError("Agent is not active");
      }
      await db
        .update(agentApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(agentApiKeys.id, gracePeriodKey.id));
      return { agent, apiKey: gracePeriodKey };
    }
    throw new UnauthorizedError("Invalid or revoked API key");
  }

  // Check expiration
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    // Mark as expired
    await db.update(agentApiKeys).set({ status: "expired" }).where(eq(agentApiKeys.id, apiKey.id));
    throw new UnauthorizedError("API key has expired");
  }

  // Fetch the agent
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, apiKey.agentId),
  });

  if (!agent) {
    throw new UnauthorizedError("Agent not found");
  }

  if (!["active", "testing", "degraded"].includes(agent.status)) {
    throw new UnauthorizedError(`Agent is ${agent.status} and cannot check in`);
  }

  // Update last used timestamp
  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, apiKey.id));

  return { agent, apiKey };
}

/**
 * Issue a short-lived run token for an agent that has checked in.
 * Run tokens are scoped to task execution and last 30 minutes.
 */
export async function issueAgentRunToken(
  agentId: string,
  companyId: string,
  departmentId: string | null,
  agentName: string,
): Promise<string> {
  const env = getEnv();
  return new SignJWT({
    company_id: companyId,
    department_id: departmentId,
    agent_name: agentName,
    scope: "task_execution",
  } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`agent:${agentId}`)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1800s") // 30 min
    .sign(getSecret());
}

/**
 * Verify an agent run token.
 * Supports dual-key verification during JWT signing key rotation:
 * tries the primary key first, falls back to secondary if set.
 */
export async function verifyAgentRunToken(token: string): Promise<AgentRunToken> {
  const env = getEnv();
  const verifyOpts = { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE };

  try {
    const { payload } = await jwtVerify(token, getSecret(), verifyOpts);
    return payload as unknown as AgentRunToken;
  } catch (primaryErr) {
    const secondary = getSecondarySecret();
    if (!secondary) throw primaryErr;

    // Fallback to secondary secret (rollover window)
    const { payload } = await jwtVerify(token, secondary, verifyOpts);
    return payload as unknown as AgentRunToken;
  }
}
