import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

describe("GET /api/health", () => {
  const app = createApp();

  it("returns ok status", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.timestamp).toBeDefined();
  });
});
