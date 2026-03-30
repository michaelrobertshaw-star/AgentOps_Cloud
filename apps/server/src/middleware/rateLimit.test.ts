/**
 * M3 QA: Rate limiting middleware tests
 *
 * Tests cover:
 *  - 429 + Retry-After when quota exceeded
 *  - X-RateLimit-Limit / Remaining / Reset headers on normal requests
 *  - Health-check routes exempted from rate limiting
 *  - Fail-open behaviour when Redis is unavailable
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response } from "express";
import { rateLimitMiddleware, disconnectRateLimitRedis } from "./rateLimit.js";
import { errorHandler } from "./errorHandler.js";

// ---------------------------------------------------------------------------
// Redis mock
// ---------------------------------------------------------------------------

// vi.hoisted() ensures these refs are available inside the vi.mock() factory
const { mockEval, mockOn, mockQuit } = vi.hoisted(() => ({
  mockEval: vi.fn(),
  mockOn: vi.fn(),
  mockQuit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    eval: mockEval,
    on: mockOn,
    quit: mockQuit,
  })),
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeApp(companyRpm = 10, userRpm = 5) {
  const app = express();
  app.use(express.json());
  app.use(rateLimitMiddleware({ companyRpm, userRpm }));

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });
  app.get("/api/health/minio", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });
  app.get("/api/data", (_req: Request, res: Response) => {
    res.json({ data: true });
  });

  app.use(errorHandler());
  return app;
}

function makeWindowResult(count: number): [number, number] {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = nowSeconds - (nowSeconds % 60);
  return [count, windowStart];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Rate limiting middleware", () => {
  beforeEach(() => {
    // Reset mock including queued once-values to prevent cross-test contamination
    mockEval.mockReset();
    mockOn.mockReset();
  });

  afterEach(async () => {
    // Reset singleton between tests
    await disconnectRateLimitRedis();
  });

  describe("normal requests — headers set correctly", () => {
    it("returns X-RateLimit-* headers on a successful unauthenticated request", async () => {
      // First call = company/IP check; no user key for unauthenticated requests
      mockEval.mockResolvedValueOnce(makeWindowResult(1));

      const app = makeApp(100, 50);
      const res = await request(app).get("/api/data");

      expect(res.status).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBeDefined();
      expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("reports decreasing remaining count as requests accumulate", async () => {
      // Unauthenticated requests use a single company/IP bucket — one eval call
      mockEval.mockResolvedValueOnce(makeWindowResult(3)); // company/IP bucket: 3 used

      const app = makeApp(10, 5);
      const res = await request(app).get("/api/data");

      // remaining = companyRpm - count = 10 - 3 = 7
      expect(res.headers["x-ratelimit-remaining"]).toBe("7");
    });
  });

  describe("rate limit exceeded — 429 response", () => {
    it("returns 429 with Retry-After when company bucket is full", async () => {
      // Company bucket count > limit
      mockEval.mockResolvedValueOnce(makeWindowResult(11)); // count=11 > limit=10

      const app = makeApp(10, 5);
      const res = await request(app).get("/api/data");

      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(res.headers["x-ratelimit-remaining"]).toBe("0");
      expect(res.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    });

    it("returns 429 when company bucket is full (unauthenticated)", async () => {
      // Unauthenticated requests use company/IP bucket; count exceeds company limit
      mockEval.mockResolvedValueOnce(makeWindowResult(6)); // company: 6/5 — exceeded

      const app = makeApp(5, 100);
      const res = await request(app).get("/api/data");

      expect(res.status).toBe(429);
      expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    });

    it("includes X-RateLimit-Limit header matching the limit that was exceeded", async () => {
      mockEval.mockResolvedValueOnce(makeWindowResult(11)); // company exceeded with limit=10

      const app = makeApp(10, 5);
      const res = await request(app).get("/api/data");

      expect(res.status).toBe(429);
      expect(res.headers["x-ratelimit-limit"]).toBe("10");
    });
  });

  describe("health-check exemption", () => {
    it("skips rate limiting for /api/health", async () => {
      // Mock should NOT be called for health routes
      const app = makeApp(0, 0); // limits of 0 would block everything else
      const res = await request(app).get("/api/health");

      expect(res.status).toBe(200);
      expect(mockEval).not.toHaveBeenCalled();
    });

    it("skips rate limiting for /api/health/minio", async () => {
      const app = makeApp(0, 0);
      const res = await request(app).get("/api/health/minio");

      expect(res.status).toBe(200);
      expect(mockEval).not.toHaveBeenCalled();
    });
  });

  describe("fail-open behaviour", () => {
    it("allows requests when Redis eval throws (fail-open)", async () => {
      mockEval.mockRejectedValueOnce(new Error("Redis connection refused"));

      const app = makeApp(10, 5);
      const res = await request(app).get("/api/data");

      // Should pass through — fail-open means the request is allowed
      expect(res.status).toBe(200);
    });
  });

  describe("X-RateLimit-Reset header", () => {
    it("sets Reset to the end of the current window (epoch seconds)", async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const windowStart = nowSeconds - (nowSeconds % 60);
      const expectedReset = windowStart + 60;

      mockEval.mockResolvedValueOnce([1, windowStart]);

      const app = makeApp(10, 5);
      const res = await request(app).get("/api/data");

      const reset = Number(res.headers["x-ratelimit-reset"]);
      // Allow ±1 second tolerance for timing
      expect(reset).toBeGreaterThanOrEqual(expectedReset - 1);
      expect(reset).toBeLessThanOrEqual(expectedReset + 1);
    });
  });
});
