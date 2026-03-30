import type { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import { decodeJwt } from "jose";
import { getEnv } from "../config/env.js";
import { AppError } from "../lib/errors.js";

// Singleton Redis client for rate limiting
let redisClient: Redis | undefined;

function getRedisClient(): Redis {
  if (!redisClient) {
    const url = new URL(getEnv().REDIS_URL);
    redisClient = new Redis({
      host: url.hostname,
      port: Number(url.port) || 6379,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    redisClient.on("error", (err) => {
      // Log but do not crash — rate limiting degrades gracefully on Redis failure
      console.error("[rateLimit] Redis error:", err.message);
    });
  }
  return redisClient;
}

/**
 * Atomic sliding-window increment using a Lua script.
 *
 * Returns [currentCount, windowStartEpochSeconds] where windowStartEpochSeconds
 * is the beginning of the current 60-second fixed window.
 *
 * The key expires automatically after one window length so no manual cleanup
 * is required.
 */
const SLIDING_WINDOW_LUA = `
local key     = KEYS[1]
local window  = tonumber(ARGV[1])  -- window length in seconds (60)
local now     = tonumber(ARGV[2])  -- current epoch seconds

-- Derive the window start by flooring to the nearest window boundary
local windowStart = now - (now % window)
local fullKey     = key .. ":" .. windowStart

-- Increment counter and set TTL only on first write to this window slot
local count = redis.call("INCR", fullKey)
if count == 1 then
  redis.call("EXPIRE", fullKey, window + 1)
end

return {count, windowStart}
`;

const WINDOW_SECONDS = 60;

/**
 * Perform a rate-limit check against Redis.
 * Returns { allowed, count, limit, windowStart }.
 * On Redis error the check is skipped (fail-open) and allowed = true.
 */
async function checkRateLimit(
  key: string,
  limit: number,
): Promise<{ allowed: boolean; count: number; limit: number; windowStart: number }> {
  const redis = getRedisClient();
  const nowSeconds = Math.floor(Date.now() / 1000);

  try {
    const result = (await redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(WINDOW_SECONDS),
      String(nowSeconds),
    )) as [number, number];

    const [count, windowStart] = result;
    return { allowed: count <= limit, count, limit, windowStart };
  } catch (err) {
    // Fail-open: if Redis is unavailable, allow the request
    console.error("[rateLimit] Redis eval error, failing open:", (err as Error).message);
    const windowStart = nowSeconds - (nowSeconds % WINDOW_SECONDS);
    return { allowed: true, count: 0, limit, windowStart };
  }
}

export interface RateLimitOptions {
  /** Requests per minute allowed per company. Defaults to env RATE_LIMIT_COMPANY_RPM. */
  companyRpm?: number;
  /** Requests per minute allowed per user. Defaults to env RATE_LIMIT_USER_RPM. */
  userRpm?: number;
}

/**
 * Per-tenant rate limiting middleware using Redis sliding window counters.
 *
 * When the authenticated user's company or user-level quota is exceeded a
 * 429 Too Many Requests response is returned with Retry-After, X-RateLimit-*
 * headers set.
 *
 * Unauthenticated requests are bucketed by IP address and checked against
 * the user-level limit.
 *
 * Health routes (/api/health*) are always skipped.
 */
export function rateLimitMiddleware(options: RateLimitOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Skip health routes
    if (req.path.startsWith("/api/health")) {
      return next();
    }

    const env = getEnv();
    const companyRpm = options.companyRpm ?? env.RATE_LIMIT_COMPANY_RPM;
    const userRpm = options.userRpm ?? env.RATE_LIMIT_USER_RPM;

    // Try to extract identity from already-parsed auth (set by authenticate()) or
    // fall back to a non-verifying JWT decode so rate limits apply even on public
    // routes that don't use the authenticate() middleware.
    let companyId = req.companyId ?? req.auth?.company_id;
    let userId = req.userId;

    if (!companyId || !userId) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        try {
          const payload = decodeJwt(authHeader.slice(7));
          if (!companyId && typeof payload.company_id === "string") {
            companyId = payload.company_id;
          }
          if (!userId && typeof payload.sub === "string") {
            userId = payload.sub.replace("user:", "");
          }
        } catch {
          // Malformed token — proceed with IP-level limiting
        }
      }
    }

    // Determine rate-limit subject
    const subjectKey: string = companyId
      ? `rl:${companyId}`
      : `rl:ip:${req.ip ?? "unknown"}`;

    const userKey: string | undefined = userId ? `rl:user:${userId}` : undefined;

    // Check company-level (or IP-level) limit
    const companyCheck = await checkRateLimit(subjectKey, companyRpm);

    // Build reset timestamp (end of the current window)
    const resetEpoch = companyCheck.windowStart + WINDOW_SECONDS;

    if (!companyCheck.allowed) {
      const retryAfter = resetEpoch - Math.floor(Date.now() / 1000);
      res.set("X-RateLimit-Limit", String(companyRpm));
      res.set("X-RateLimit-Remaining", "0");
      res.set("X-RateLimit-Reset", String(resetEpoch));
      res.set("Retry-After", String(Math.max(retryAfter, 1)));
      return next(
        new AppError(
          429,
          "RATE_LIMIT_EXCEEDED",
          "Too many requests. Please slow down and retry after the reset window.",
          { retryAfter: Math.max(retryAfter, 1) },
        ),
      );
    }

    // Check user-level limit (more granular, lower quota)
    if (userKey) {
      const userCheck = await checkRateLimit(userKey, userRpm);
      const userResetEpoch = userCheck.windowStart + WINDOW_SECONDS;

      if (!userCheck.allowed) {
        const retryAfter = userResetEpoch - Math.floor(Date.now() / 1000);
        res.set("X-RateLimit-Limit", String(userRpm));
        res.set("X-RateLimit-Remaining", "0");
        res.set("X-RateLimit-Reset", String(userResetEpoch));
        res.set("Retry-After", String(Math.max(retryAfter, 1)));
        return next(
          new AppError(
            429,
            "RATE_LIMIT_EXCEEDED",
            "Too many requests. Please slow down and retry after the reset window.",
            { retryAfter: Math.max(retryAfter, 1) },
          ),
        );
      }

      // Attach headers reflecting the tighter of the two limits
      const effectiveRemaining = Math.min(
        companyRpm - companyCheck.count,
        userRpm - userCheck.count,
      );
      res.set("X-RateLimit-Limit", String(userRpm));
      res.set("X-RateLimit-Remaining", String(Math.max(effectiveRemaining, 0)));
      res.set("X-RateLimit-Reset", String(userResetEpoch));
    } else {
      // Unauthenticated — reflect company/IP bucket headers
      const remaining = Math.max(companyRpm - companyCheck.count, 0);
      res.set("X-RateLimit-Limit", String(companyRpm));
      res.set("X-RateLimit-Remaining", String(remaining));
      res.set("X-RateLimit-Reset", String(resetEpoch));
    }

    return next();
  };
}

/**
 * Disconnect the shared Redis client. Call this during graceful shutdown.
 */
export async function disconnectRateLimitRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = undefined;
  }
}
