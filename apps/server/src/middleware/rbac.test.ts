import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { authenticate } from "./auth.js";
import { requirePermission } from "./rbac.js";
import { errorHandler } from "./errorHandler.js";
import { issueAccessToken } from "../services/authService.js";

function createTestApp() {
  const app = express();
  app.use(express.json());

  // Protected route requiring company:view
  app.get(
    "/test/company",
    authenticate(),
    requirePermission("company:view"),
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  // Protected route requiring department:manage
  app.get(
    "/test/dept/:departmentId",
    authenticate(),
    requirePermission("department:manage"),
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  app.use(errorHandler());
  return app;
}

describe("RBAC middleware", () => {
  const app = createTestApp();

  it("allows oneops_admin to access company:view", async () => {
    const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});
    const res = await request(app)
      .get("/test/company")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("allows customer_user to access company:view", async () => {
    const token = await issueAccessToken("user-1", "co-1", ["customer_user"], {});
    const res = await request(app)
      .get("/test/company")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("denies department viewer from company:view", async () => {
    // Viewer at department level doesn't have company:view
    const token = await issueAccessToken("user-1", "co-1", [], {
      "dept-1": "viewer",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .get("/test/company")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("allows department_manager to manage their department", async () => {
    const token = await issueAccessToken("user-1", "co-1", [], {
      "dept-1": "department_manager",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .get("/test/dept/dept-1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("denies operator from managing a department", async () => {
    const token = await issueAccessToken("user-1", "co-1", [], {
      "dept-1": "operator",
    } as Record<string, "department_manager" | "operator" | "viewer">);
    const res = await request(app)
      .get("/test/dept/dept-1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/test/company");
    expect(res.status).toBe(401);
  });
});
