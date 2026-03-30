import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

// Mock rate-limit Redis so health tests don't need a real Redis connection
vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    eval: vi.fn().mockResolvedValue([1, Math.floor(Date.now() / 1000) - 30]),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock storage service to control MinIO health responses
vi.mock("../services/storageService.js", () => ({
  checkMinioHealth: vi.fn(),
}));

import { checkMinioHealth } from "../services/storageService.js";

describe("GET /api/health", () => {
  const app = createApp();

  it("returns ok status", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.timestamp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// M3 QA: MinIO health endpoint
// ---------------------------------------------------------------------------

describe("GET /api/health/minio (M3)", () => {
  const app = createApp();

  it("returns 200 with healthy status when MinIO is reachable", async () => {
    vi.mocked(checkMinioHealth).mockResolvedValue({ healthy: true });

    const res = await request(app).get("/api/health/minio");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.minio.healthy).toBe(true);
    expect(res.body.timestamp).toBeDefined();
  });

  it("returns 503 with error status when MinIO is unreachable", async () => {
    vi.mocked(checkMinioHealth).mockResolvedValue({
      healthy: false,
      error: "Connection refused",
    });

    const res = await request(app).get("/api/health/minio");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.minio.healthy).toBe(false);
    expect(res.body.minio.error).toBe("Connection refused");
  });
});
