/**
 * Integration tests for M3.4: Webhook management endpoints.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------
const COMPANY_ID = "co-1";
const USER_ID = "user-1";
const WEBHOOK_ID = "00000000-0000-0000-0000-000000000070";

const mockWebhook = {
  id: WEBHOOK_ID,
  companyId: COMPANY_ID,
  url: "https://example.com/hook",
  secret: "supersecretvalue12345",
  events: ["task.completed", "incident.created"],
  status: "active",
  failureCount: 0,
  lastTriggeredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockDelivery = {
  id: "00000000-0000-0000-0000-000000000071",
  companyId: COMPANY_ID,
  webhookId: WEBHOOK_ID,
  eventType: "test.ping",
  payload: { event: "test.ping" },
  statusCode: 200,
  responseBody: "ok",
  attemptNumber: 1,
  success: true,
  errorMessage: null,
  durationMs: 42,
  deliveredAt: new Date(),
};

// ----------------------------------------------------------------
// Mutable state
// ----------------------------------------------------------------
let webhookFindFirst: typeof mockWebhook | null = mockWebhook;
let webhookFindMany: typeof mockWebhook[] = [mockWebhook];
let deliveryFindMany: typeof mockDelivery[] = [];

const insertReturning = vi.fn(() => Promise.resolve([mockWebhook] as unknown[]));
const updateReturning = vi.fn(() => Promise.resolve([mockWebhook] as unknown[]));
const deleteMock = vi.fn(() => Promise.resolve());

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      webhooks: {
        findFirst: vi.fn(() => Promise.resolve(webhookFindFirst)),
        findMany: vi.fn(() => Promise.resolve(webhookFindMany)),
      },
      webhookDeliveries: {
        findMany: vi.fn(() => Promise.resolve(deliveryFindMany)),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: insertReturning })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: updateReturning })),
      })),
    })),
    delete: vi.fn(() => ({
      where: deleteMock,
    })),
  }),
}));

vi.mock("../middleware/audit.js", () => ({
  auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => {
    (_req as { audit: () => Promise<void> }).audit = async () => {};
    next();
  },
}));

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    eval: vi.fn().mockResolvedValue([1, Math.floor(Date.now() / 1000) - 30]),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock fetch globally for test ping endpoint
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    text: async () => "ok",
  }),
);

// Mock webhookService to prevent actual HTTP calls
vi.mock("../services/webhookService.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/webhookService.js")>();
  return {
    ...original,
    attemptDelivery: vi.fn().mockResolvedValue({
      success: true,
      statusCode: 200,
      responseBody: "ok",
      durationMs: 42,
      errorMessage: null,
    }),
  };
});

// ----------------------------------------------------------------
// Tests: POST (create)
// ----------------------------------------------------------------

describe("POST /api/companies/:companyId/webhooks", () => {
  const app = createApp();

  beforeEach(() => {
    insertReturning.mockResolvedValue([mockWebhook]);
  });

  it("creates webhook for company_admin and returns 201", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/webhooks`)
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "https://example.com/hook", events: ["task.completed"] });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("secret"); // secret visible on creation
  });

  it("returns 403 for auditor (no company:manage)", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["auditor"], {});
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/webhooks`)
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "https://example.com/hook", events: ["task.completed"] });
    expect(res.status).toBe(403);
  });

  it("returns 403 when acting on another company", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .post(`/api/companies/other-company/webhooks`)
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "https://example.com/hook", events: ["task.completed"] });
    expect(res.status).toBe(403);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/webhooks`)
      .send({ url: "https://example.com/hook", events: ["task.completed"] });
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid URL", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/webhooks`)
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "not-a-url", events: ["task.completed"] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when events is empty", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/webhooks`)
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "https://example.com/hook", events: [] });
    expect(res.status).toBe(400);
  });
});

// ----------------------------------------------------------------
// Tests: GET list
// ----------------------------------------------------------------

describe("GET /api/companies/:companyId/webhooks", () => {
  const app = createApp();

  beforeEach(() => {
    webhookFindMany = [mockWebhook];
  });

  it("returns list for company_admin with masked secrets", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/webhooks`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].secret).toBe("***");
  });

  it("returns 403 for auditor", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["auditor"], {});
    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/webhooks`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/webhooks`);
    expect(res.status).toBe(401);
  });
});

// ----------------------------------------------------------------
// Tests: PATCH (update)
// ----------------------------------------------------------------

describe("PATCH /api/webhooks/:id", () => {
  const app = createApp();

  beforeEach(() => {
    webhookFindFirst = mockWebhook;
    updateReturning.mockResolvedValue([{ ...mockWebhook, status: "paused" }]);
  });

  it("updates webhook for company_admin", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .patch(`/api/webhooks/${WEBHOOK_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "paused" });
    expect(res.status).toBe(200);
    expect(res.body.secret).toBe("***");
  });

  it("returns 404 for non-existent webhook", async () => {
    webhookFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .patch(`/api/webhooks/00000000-0000-0000-0000-000000000099`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "paused" });
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .patch(`/api/webhooks/${WEBHOOK_ID}`)
      .send({ status: "paused" });
    expect(res.status).toBe(401);
  });
});

// ----------------------------------------------------------------
// Tests: DELETE
// ----------------------------------------------------------------

describe("DELETE /api/webhooks/:id", () => {
  const app = createApp();

  beforeEach(() => {
    webhookFindFirst = mockWebhook;
    deleteMock.mockResolvedValue(undefined);
  });

  it("deletes webhook for company_admin and returns 200", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .delete(`/api/webhooks/${WEBHOOK_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Webhook deleted");
  });

  it("returns 404 for non-existent webhook", async () => {
    webhookFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .delete(`/api/webhooks/00000000-0000-0000-0000-000000000099`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).delete(`/api/webhooks/${WEBHOOK_ID}`);
    expect(res.status).toBe(401);
  });
});

// ----------------------------------------------------------------
// Tests: POST test ping
// ----------------------------------------------------------------

describe("POST /api/webhooks/:id/test", () => {
  const app = createApp();

  beforeEach(() => {
    webhookFindFirst = mockWebhook;
    insertReturning.mockResolvedValue([mockDelivery]);
  });

  it("sends test ping and returns delivery result with HMAC signature", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .post(`/api/webhooks/${WEBHOOK_ID}/test`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success");
    expect(res.body).toHaveProperty("signature");
    expect(res.body.signature).toMatch(/^sha256=/);
    expect(res.body).toHaveProperty("delivery");
  });

  it("returns 404 for non-existent webhook", async () => {
    webhookFindFirst = null;
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .post(`/api/webhooks/00000000-0000-0000-0000-000000000099/test`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).post(`/api/webhooks/${WEBHOOK_ID}/test`);
    expect(res.status).toBe(401);
  });
});

// ----------------------------------------------------------------
// Tests: GET deliveries
// ----------------------------------------------------------------

describe("GET /api/webhooks/:id/deliveries", () => {
  const app = createApp();

  beforeEach(() => {
    webhookFindFirst = mockWebhook;
    deliveryFindMany = [mockDelivery];
  });

  it("returns delivery log for company_admin", async () => {
    const token = await issueAccessToken(USER_ID, COMPANY_ID, ["company_admin"], {});
    const res = await request(app)
      .get(`/api/webhooks/${WEBHOOK_ID}/deliveries`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/api/webhooks/${WEBHOOK_ID}/deliveries`);
    expect(res.status).toBe(401);
  });
});

// ----------------------------------------------------------------
// Tests: HMAC signature verification
// ----------------------------------------------------------------

describe("HMAC signature validation", () => {
  it("buildSignature produces valid sha256 HMAC", async () => {
    const { buildSignature } = await import("../services/webhookService.js");
    const secret = "testsecret";
    const body = JSON.stringify({ event: "test" });
    const sig = buildSignature(secret, body);
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});
