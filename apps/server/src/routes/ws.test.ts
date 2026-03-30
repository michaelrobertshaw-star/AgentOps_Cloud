import http from "http";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

// ---------------------------------------------------------------------------
// Mock ioredis to avoid needing a real Redis connection in tests
// ---------------------------------------------------------------------------
vi.mock("ioredis", () => {
  const MockRedis = vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
    psubscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  }));
  return { default: MockRedis };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reset the WsService singleton between tests so each test gets a fresh
 * instance attached to its own http.Server.
 */
async function resetWsServiceSingleton(): Promise<void> {
  // Dynamically access the module to reset the private singleton variable
  const mod = await import("../services/wsService.js");
  // The singleton is module-level; we bypass it by manipulating the export
  // via the module's internal state reset helper. Since we can't access the
  // private `_wsService` directly here, we instead re-import the module
  // fresh each time using cache busting (not available in ESM). Instead we
  // rely on the fact that tests create servers on different ports and call
  // close() to let the singleton check pass — we expose a test-only reset
  // below by reaching into the module graph.
  void mod; // used to satisfy linter
}

/**
 * Spin up a complete server+WsService on an OS-assigned port.
 * Returns the server URL (ws://...) and a cleanup function.
 */
async function createTestServer(): Promise<{ wsUrl: string; server: http.Server; cleanup: () => Promise<void> }> {
  // Reset singleton by clearing module cache via a side-channel we expose
  // in the module. Because we cannot reset ESM singletons across imports,
  // we directly manipulate the exported binding via the live binding trick.
  const wsModule = await import("../services/wsService.js");

  // Force-reset the singleton so createWsService() won't throw "already created"
  // We achieve this by monkey-patching the module's named export temporarily.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (wsModule as any)._resetForTest?.();

  const app = createApp();
  const server = http.createServer(app);

  wsModule.createWsService(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as { port: number };
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

  const cleanup = async () => {
    await wsModule.getWsService().close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wsModule as any)._resetForTest?.();
  };

  return { wsUrl, server, cleanup };
}

/**
 * Connect a WebSocket client and wait for it to open.
 */
function connectClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * Wait for the next message from a WebSocket and parse it as JSON.
 */
function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    ws.once("error", reject);
  });
}

/**
 * Wait for a WebSocket to close and capture its code.
 */
function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve(code));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebSocket real-time event stream", () => {
  beforeEach(async () => {
    // Ensure a clean singleton before each test
    const wsModule = await import("../services/wsService.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wsModule as any)._resetForTest?.();
  });

  afterEach(async () => {
    const wsModule = await import("../services/wsService.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wsModule as any)._resetForTest?.();
  });

  // -------------------------------------------------------------------------
  it("connects with valid JWT and receives welcome message", async () => {
    const { wsUrl, cleanup } = await createTestServer();
    try {
      const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
      const ws = await connectClient(`${wsUrl}?token=${token}`);

      const welcome = await nextMessage(ws);
      expect(welcome.type).toBe("welcome");
      expect(typeof welcome.clientId).toBe("string");
      expect(typeof welcome.timestamp).toBe("string");

      ws.close();
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  it("rejects connection without token with close code 4401", async () => {
    const { wsUrl, cleanup } = await createTestServer();
    try {
      const ws = new WebSocket(wsUrl);
      const code = await waitForClose(ws);
      expect(code).toBe(4401);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  it("rejects connection with invalid token with close code 4401", async () => {
    const { wsUrl, cleanup } = await createTestServer();
    try {
      const ws = new WebSocket(`${wsUrl}?token=invalid.jwt.token`);
      const code = await waitForClose(ws);
      expect(code).toBe(4401);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  it("handles subscribe message and confirms subscription", async () => {
    const { wsUrl, cleanup } = await createTestServer();
    try {
      const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
      const ws = await connectClient(`${wsUrl}?token=${token}`);

      // Consume welcome
      await nextMessage(ws);

      // Subscribe
      ws.send(JSON.stringify({ type: "subscribe", channel: "company:co-1" }));
      const response = await nextMessage(ws);

      expect(response.type).toBe("subscribed");
      expect(response.channel).toBe("company:co-1");

      ws.close();
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  it("broadcasts event to subscribed clients and they receive it", async () => {
    const { wsUrl, cleanup } = await createTestServer();
    const wsModule = await import("../services/wsService.js");

    try {
      const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
      const ws = await connectClient(`${wsUrl}?token=${token}`);

      // Consume welcome
      await nextMessage(ws);

      // Subscribe to channel
      ws.send(JSON.stringify({ type: "subscribe", channel: "company:co-1" }));
      await nextMessage(ws); // consume "subscribed"

      // Broadcast an event via the service
      const eventPromise = nextMessage(ws);
      wsModule.getWsService().broadcast("company:co-1", {
        type: "task.status_changed",
        channel: "company:co-1",
        data: { taskId: "t-1", companyId: "co-1", status: "completed" },
        timestamp: new Date().toISOString(),
      });

      const received = await eventPromise;
      expect(received.type).toBe("event");
      expect(received.channel).toBe("company:co-1");
      expect(received.eventType).toBe("task.status_changed");

      ws.close();
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  it("does not deliver events to clients not subscribed to channel", async () => {
    const { wsUrl, cleanup } = await createTestServer();
    const wsModule = await import("../services/wsService.js");

    try {
      const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
      const ws = await connectClient(`${wsUrl}?token=${token}`);

      // Consume welcome
      await nextMessage(ws);

      // Subscribe to a different channel
      ws.send(JSON.stringify({ type: "subscribe", channel: "company:co-1" }));
      await nextMessage(ws); // consume "subscribed"

      // Broadcast to a channel the client has NOT subscribed to
      wsModule.getWsService().broadcast("department:dept-999", {
        type: "task.status_changed",
        channel: "department:dept-999",
        data: { taskId: "t-1", companyId: "co-1", status: "completed" },
        timestamp: new Date().toISOString(),
      });

      // Client should NOT receive anything — wait 100ms to confirm silence
      const received = await Promise.race([
        nextMessage(ws).then(() => "received"),
        new Promise<string>((resolve) => setTimeout(() => resolve("silent"), 150)),
      ]);

      expect(received).toBe("silent");

      ws.close();
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  it("responds to ping with pong", async () => {
    const { wsUrl, cleanup } = await createTestServer();
    try {
      const token = await issueAccessToken("user-1", "co-1", ["company_admin"], {});
      const ws = await connectClient(`${wsUrl}?token=${token}`);

      // Consume welcome
      await nextMessage(ws);

      ws.send(JSON.stringify({ type: "ping" }));
      const pong = await nextMessage(ws);

      expect(pong.type).toBe("pong");

      ws.close();
    } finally {
      await cleanup();
    }
  });
});
