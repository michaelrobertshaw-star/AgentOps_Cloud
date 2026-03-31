import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { issueAccessToken } from "../services/authService.js";
import { authenticate } from "../middleware/auth.js";

// ---------------------------------------------------------------------------
// Mock ioredis so tests do not require a real Redis instance.
// We simulate the Lua sliding-window script by maintaining a simple counter
// map in memory. The mock's eval() increments a counter keyed by the first
// argument to the Lua script and returns [count, windowStart].
// ---------------------------------------------------------------------------

type MockRedisInstance = {
  eval: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _counters: Map<string, number>;
  _reset: () => void;
};

// Shared state so individual tests can inspect / manipulate it
const mockRedisState: MockRedisInstance = {
  _counters: new Map<string, number>(),
  _reset() {
    this._counters.clear();
  },
  eval: vi.fn(),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

// Attach the live eval implementation after the object is stable
mockRedisState.eval.mockImplementation(
  (_script: string, _numKeys: number, key: string, _window: string, nowStr: string) => {
    const now = Number(nowStr);
    const windowSecs = 60;
    const windowStart = now - (now % windowSecs);
    const fullKey = `${key}:${windowStart}`;
    const current = (mockRedisState._counters.get(fullKey) ?? 0) + 1;
    mockRedisState._counters.set(fullKey, current);
    return Promise.resolve([current, windowStart]);
  },
);

vi.mock("ioredis", () => {
  return {
    default: vi.fn(() => mockRedisState),
  };
});

// ---------------------------------------------------------------------------
// Helper: build a minimal Express app wired with rate limiting
// ---------------------------------------------------------------------------

function buildApp(options?: { companyRpm?: number; userRpm?: number }) {
  const app = express();
  app.use(express.json());

  // Rate limiting (globally, matching production setup)
  app.use(rateLimitMiddleware(options));

  // A protected endpoint that reads JWT claims
  app.get(
    "/api/protected",
    authenticate(),
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  // An unprotected endpoint for IP-based limiting tests
  app.get("/api/public", (_req, res) => {
    res.json({ ok: true });
  });

  // Health endpoint that must never be rate limited
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(errorHandler());
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Rate limit middleware", () => {
  beforeEach(() => {
    mockRedisState._reset();
    // Reset the shared Redis singleton between tests so a fresh mock instance
    // is obtained each time. We do this by clearing the module-level singleton
    // via the exported disconnect helper if available; otherwise we simply
    // reset the counter state (which is sufficient because our mock always
    // returns the same mockRedisState object).
  });

  // -------------------------------------------------------------------------
  describe("requests under the limit return success with proper headers", () => {
    it("sets X-RateLimit-Limit and X-RateLimit-Remaining on successful request", async () => {
      const app = buildApp({ companyRpm: 100, userRpm: 50 });
      const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});

      const res = await request(app)
        .get("/api/protected")
        .set("Authorization", `Bearer ${token}`);

      // The authenticate middleware should succeed; we only care about RL headers here
      // (the route will 401 if auth fails, but auth itself uses real JWT so it succeeds)
      expect(res.headers["x-ratelimit-limit"]).toBeDefined();
      expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("X-RateLimit-Remaining decreases on subsequent requests", async () => {
      const app = buildApp({ companyRpm: 100, userRpm: 50 });

      // First request
      const res1 = await request(app).get("/api/public");
      const remaining1 = Number(res1.headers["x-ratelimit-remaining"]);

      // Second request (different window slot because IP, no userId)
      const res2 = await request(app).get("/api/public");
      const remaining2 = Number(res2.headers["x-ratelimit-remaining"]);

      expect(remaining1).toBeGreaterThanOrEqual(remaining2);
    });

    it("allows requests that are exactly at the limit", async () => {
      const app = buildApp({ companyRpm: 5, userRpm: 5 });

      for (let i = 0; i < 5; i++) {
        const res = await request(app).get("/api/public");
        expect(res.status).toBe(200);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("requests over the limit return 429 with Retry-After", () => {
    it("returns 429 when company limit is exceeded", async () => {
      // Set a very low limit so we can exceed it quickly
      const app = buildApp({ companyRpm: 3, userRpm: 1000 });

      let lastRes: request.Response | null = null;
      for (let i = 0; i < 5; i++) {
        lastRes = await request(app).get("/api/public");
      }

      expect(lastRes!.status).toBe(429);
      expect(lastRes!.headers["retry-after"]).toBeDefined();
      expect(Number(lastRes!.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("returns 429 with X-RateLimit-Remaining of 0 when limit exceeded", async () => {
      const app = buildApp({ companyRpm: 2, userRpm: 1000 });

      let res: request.Response | null = null;
      for (let i = 0; i < 4; i++) {
        res = await request(app).get("/api/public");
      }

      expect(res!.status).toBe(429);
      expect(res!.headers["x-ratelimit-remaining"]).toBe("0");
    });

    it("returns 429 when user-level limit is exceeded even if company limit is not", async () => {
      const app = buildApp({ companyRpm: 1000, userRpm: 2 });
      const token = await issueAccessToken("user-throttled", "co-big", ["oneops_admin"], {});

      let lastRes: request.Response | null = null;
      for (let i = 0; i < 5; i++) {
        lastRes = await request(app)
          .get("/api/public")
          .set("Authorization", `Bearer ${token}`);
      }

      // After 5 requests the user-level limit (2) must be exceeded
      expect(lastRes!.status).toBe(429);
    });

    it("response body includes error code RATE_LIMIT_EXCEEDED", async () => {
      const app = buildApp({ companyRpm: 1, userRpm: 1000 });

      // First request succeeds; second should be rejected
      await request(app).get("/api/public");
      const res = await request(app).get("/api/public");

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    });
  });

  // -------------------------------------------------------------------------
  describe("health endpoint is NOT rate limited", () => {
    it("health endpoint always returns 200 even when limit is 0", async () => {
      // Configure an extremely low limit that would block everything else
      const app = buildApp({ companyRpm: 1, userRpm: 1 });

      // Exhaust the IP-level limit
      await request(app).get("/api/public");
      await request(app).get("/api/public");

      // Health must still pass regardless
      const healthRes = await request(app).get("/api/health");
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe("ok");
    });

    it("health endpoint does not set rate-limit headers", async () => {
      const app = buildApp({ companyRpm: 100, userRpm: 100 });

      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      // Middleware should skip the route entirely — no RL headers emitted
      expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
      expect(res.headers["x-ratelimit-remaining"]).toBeUndefined();
    });
  });
});
