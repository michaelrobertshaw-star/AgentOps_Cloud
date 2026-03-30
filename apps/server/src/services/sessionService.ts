import Redis from "ioredis";
import { eq, asc, inArray } from "drizzle-orm";
import { sessions } from "@agentops/db";
import { getEnv } from "../config/env.js";
import { getDb } from "../lib/db.js";

// ─── Redis ────────────────────────────────────────────────────────────────────

let _redis: Redis | undefined;

function getRedisClient(): Redis {
  if (!_redis) {
    const url = new URL(getEnv().REDIS_URL);
    _redis = new Redis({
      host: url.hostname,
      port: Number(url.port) || 6379,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    _redis.on("error", (err) => {
      console.error("[sessionService] Redis error:", (err as Error).message);
    });
  }
  return _redis;
}

const idleKey = (sessionId: string) => `session:idle:${sessionId}`;

// ─── Redis TTL helpers ────────────────────────────────────────────────────────

/** Register a session in Redis with idle-timeout TTL. Fail-open on error. */
export async function createSessionInRedis(sessionId: string): Promise<void> {
  const ttl = getEnv().SESSION_IDLE_TIMEOUT_HOURS * 3600;
  try {
    await getRedisClient().set(idleKey(sessionId), "1", "EX", ttl);
  } catch (err) {
    console.error("[sessionService] failed to set Redis idle key:", (err as Error).message);
  }
}

/** Reset the idle-timeout TTL for an active session. Fail-open on error. */
export async function touchSessionRedis(sessionId: string): Promise<void> {
  const ttl = getEnv().SESSION_IDLE_TIMEOUT_HOURS * 3600;
  try {
    await getRedisClient().expire(idleKey(sessionId), ttl);
  } catch (err) {
    console.error("[sessionService] failed to touch Redis idle key:", (err as Error).message);
  }
}

/** Remove session idle-timeout key from Redis. Fail-open on error. */
export async function removeSessionFromRedis(sessionId: string): Promise<void> {
  try {
    await getRedisClient().del(idleKey(sessionId));
  } catch (err) {
    console.error("[sessionService] failed to delete Redis idle key:", (err as Error).message);
  }
}

/** Check if a session is alive in Redis. Fails-open (returns true) on Redis error. */
async function isSessionAliveInRedis(sessionId: string): Promise<boolean> {
  try {
    const exists = await getRedisClient().exists(idleKey(sessionId));
    return exists === 1;
  } catch {
    return true; // fail-open: assume alive if Redis is unreachable
  }
}

// ─── Session types ────────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
}

// ─── Session management ───────────────────────────────────────────────────────

/**
 * List all active (non-idle-expired, non-hard-expired) sessions for a user.
 * Lazily prunes idle-expired sessions from Postgres.
 */
export async function listActiveSessions(userId: string): Promise<SessionInfo[]> {
  const db = getDb();
  const now = new Date();

  const allSessions = await db.query.sessions.findMany({
    where: eq(sessions.userId, userId),
    orderBy: [asc(sessions.createdAt)],
  });

  // Filter out sessions past their hard expiry
  const notExpired = allSessions.filter((s) => s.expiresAt > now);

  // Check Redis idle-timeout for each session
  const withAliveStatus = await Promise.all(
    notExpired.map(async (s) => ({ session: s, alive: await isSessionAliveInRedis(s.id) })),
  );

  // Lazily prune idle-expired sessions from Postgres
  const deadIds = withAliveStatus.filter((r) => !r.alive).map((r) => r.session.id);
  if (deadIds.length > 0) {
    db.delete(sessions)
      .where(inArray(sessions.id, deadIds))
      .catch((e: Error) => console.error("[sessionService] prune error:", e.message));
  }

  return withAliveStatus
    .filter((r) => r.alive)
    .map((r) => ({
      id: r.session.id,
      ipAddress: r.session.ipAddress ?? null,
      userAgent: r.session.userAgent ?? null,
      createdAt: r.session.createdAt,
      lastActiveAt: r.session.lastActiveAt,
      expiresAt: r.session.expiresAt,
    }));
}

/**
 * Revoke a specific session by ID. Returns false if the session does not
 * belong to the given user.
 */
export async function revokeSession(sessionId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });

  if (!session || session.userId !== userId) return false;

  await db.delete(sessions).where(eq(sessions.id, sessionId));
  await removeSessionFromRedis(sessionId);
  return true;
}

/**
 * Revoke all sessions for a user, optionally keeping one (e.g. current session).
 * Returns the number of sessions revoked.
 */
export async function revokeAllSessions(
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const db = getDb();

  const allSessions = await db.query.sessions.findMany({
    where: eq(sessions.userId, userId),
  });

  const targets = exceptSessionId
    ? allSessions.filter((s) => s.id !== exceptSessionId)
    : allSessions;

  if (targets.length === 0) return 0;

  const targetIds = targets.map((s) => s.id);
  await db.delete(sessions).where(inArray(sessions.id, targetIds));
  await Promise.all(targetIds.map((id) => removeSessionFromRedis(id)));

  return targets.length;
}

/**
 * Enforce the concurrent session limit for a user. If the user has more
 * sessions than SESSION_MAX_CONCURRENT, the oldest ones are evicted.
 */
export async function enforceSessionLimit(userId: string): Promise<void> {
  const db = getDb();
  const limit = getEnv().SESSION_MAX_CONCURRENT;

  const allSessions = await db.query.sessions.findMany({
    where: eq(sessions.userId, userId),
    orderBy: [asc(sessions.createdAt)],
  });

  if (allSessions.length <= limit) return;

  const toEvict = allSessions.slice(0, allSessions.length - limit);
  const evictIds = toEvict.map((s) => s.id);

  await db.delete(sessions).where(inArray(sessions.id, evictIds));
  await Promise.all(evictIds.map((id) => removeSessionFromRedis(id)));
}

export async function disconnectSessionRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = undefined;
  }
}
