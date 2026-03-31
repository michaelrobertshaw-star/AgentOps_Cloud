/**
 * M3 QA: WebSocket service unit tests
 *
 * Tests cover:
 *  - JWT authentication (valid token accepted, expired/missing rejected)
 *  - Channel subscribe / unsubscribe
 *  - Broadcast fan-out (company isolation enforced)
 *  - ping/pong keepalive
 *  - Invalid message handling
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import WebSocket from "ws";
import { WsService } from "./wsService.js";
import { issueAccessToken } from "./authService.js";

// ---------------------------------------------------------------------------
// Redis mock — prevent real Redis connections in unit tests
// ---------------------------------------------------------------------------

const mockRedisConnect = vi.fn().mockResolvedValue(undefined);
const mockRedisPublish = vi.fn().mockResolvedValue(1);
const mockRedisPsubscribe = vi.fn().mockResolvedValue(undefined);
const mockRedisQuit = vi.fn().mockResolvedValue(undefined);
const mockRedisOn = vi.fn();

vi.mock("ioredis", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      connect: mockRedisConnect,
      publish: mockRedisPublish,
      psubscribe: mockRedisPsubscribe,
      on: mockRedisOn,
      quit: mockRedisQuit,
    })),
  };
});

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function createTestServer(): { server: http.Server; wsService: WsService } {
  const server = http.createServer();
  const wsService = new WsService(server);
  return { server, wsService };
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Message timeout")), 2000);
    ws.once("message", (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function connectWs(
  server: http.Server,
  token?: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const url = `ws://127.0.0.1:${addr.port}/ws`;
    const ws = token
      ? new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } })
      : new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function listenServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WsService — authentication", () => {
  let server: http.Server;
  let wsService: WsService;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ server, wsService } = createTestServer());
    await listenServer(server);
  });

  afterEach(async () => {
    await wsService.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("accepts a valid JWT and sends a welcome message", async () => {
    const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});
    const ws = await connectWs(server, token);
    const msg = await waitForMessage(ws);

    expect(msg.type).toBe("welcome");
    expect(typeof msg.clientId).toBe("string");
    expect(typeof msg.timestamp).toBe("string");

    ws.close();
  });

  it("rejects connection with no token (closes with code 4401)", async () => {
    const ws = await connectWs(server); // no token
    const { code } = await waitForClose(ws);
    expect(code).toBe(4401);
  });

  it("rejects connection with an invalid JWT (closes with code 4401)", async () => {
    const ws = await connectWs(server, "not.a.valid.jwt");
    const { code } = await waitForClose(ws);
    expect(code).toBe(4401);
  });
});

describe("WsService — channel subscribe / unsubscribe", () => {
  let server: http.Server;
  let wsService: WsService;
  let ws: WebSocket;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ server, wsService } = createTestServer());
    await listenServer(server);

    const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});
    ws = await connectWs(server, token);
    // Consume the welcome message
    await waitForMessage(ws);
  });

  afterEach(async () => {
    ws.close();
    await wsService.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("acknowledges subscribe to a valid channel", async () => {
    ws.send(JSON.stringify({ type: "subscribe", channel: "company:co-1" }));
    const msg = await waitForMessage(ws);

    expect(msg.type).toBe("subscribed");
    expect(msg.channel).toBe("company:co-1");
  });

  it("acknowledges subscribe to a department channel", async () => {
    ws.send(JSON.stringify({ type: "subscribe", channel: "department:dept-1" }));
    const msg = await waitForMessage(ws);

    expect(msg.type).toBe("subscribed");
    expect(msg.channel).toBe("department:dept-1");
  });

  it("acknowledges subscribe to a task channel", async () => {
    ws.send(JSON.stringify({ type: "subscribe", channel: "task:task-1" }));
    const msg = await waitForMessage(ws);

    expect(msg.type).toBe("subscribed");
  });

  it("rejects subscription to an invalid channel prefix", async () => {
    ws.send(JSON.stringify({ type: "subscribe", channel: "unknown:foo" }));
    const msg = await waitForMessage(ws);

    expect(msg.type).toBe("error");
  });

  it("rejects subscription with missing channel field", async () => {
    ws.send(JSON.stringify({ type: "subscribe" }));
    const msg = await waitForMessage(ws);

    expect(msg.type).toBe("error");
  });

  it("acknowledges unsubscribe from a channel", async () => {
    // First subscribe
    ws.send(JSON.stringify({ type: "subscribe", channel: "task:task-1" }));
    await waitForMessage(ws); // consume subscribed ack

    // Then unsubscribe
    ws.send(JSON.stringify({ type: "unsubscribe", channel: "task:task-1" }));
    const msg = await waitForMessage(ws);

    expect(msg.type).toBe("unsubscribed");
    expect(msg.channel).toBe("task:task-1");
  });
});

describe("WsService — ping / pong", () => {
  let server: http.Server;
  let wsService: WsService;
  let ws: WebSocket;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ server, wsService } = createTestServer());
    await listenServer(server);

    const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});
    ws = await connectWs(server, token);
    await waitForMessage(ws); // welcome
  });

  afterEach(async () => {
    ws.close();
    await wsService.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("responds to ping with pong", async () => {
    ws.send(JSON.stringify({ type: "ping" }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe("pong");
  });
});

describe("WsService — broadcast and company isolation", () => {
  let server: http.Server;
  let wsService: WsService;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ server, wsService } = createTestServer());
    await listenServer(server);
  });

  afterEach(async () => {
    await wsService.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("delivers broadcast to clients subscribed to the channel", async () => {
    const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});
    const ws = await connectWs(server, token);
    await waitForMessage(ws); // welcome

    // Subscribe
    ws.send(JSON.stringify({ type: "subscribe", channel: "company:co-1" }));
    await waitForMessage(ws); // subscribed ack

    // Broadcast
    const msgPromise = waitForMessage(ws);
    wsService.broadcast("company:co-1", {
      type: "task.status_changed",
      channel: "company:co-1",
      data: { companyId: "co-1", taskId: "t-1", status: "done" },
      timestamp: new Date().toISOString(),
    });

    const received = await msgPromise;
    expect(received.type).toBe("event");
    expect(received.eventType).toBe("task.status_changed");

    ws.close();
  });

  it("does NOT deliver broadcast to clients in a different company", async () => {
    // Client in company co-2
    const tokenB = await issueAccessToken("user-2", "co-2", ["oneops_admin"], {});
    const wsB = await connectWs(server, tokenB);
    await waitForMessage(wsB); // welcome

    wsB.send(JSON.stringify({ type: "subscribe", channel: "company:co-1" }));
    await waitForMessage(wsB); // subscribed ack (subscription accepted but event won't arrive)

    // Track if a message is received within 300ms
    let messageReceived = false;
    wsB.on("message", () => { messageReceived = true; });

    wsService.broadcast("company:co-1", {
      type: "task.status_changed",
      channel: "company:co-1",
      data: { companyId: "co-1", taskId: "t-1", status: "done" },
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(messageReceived).toBe(false);

    wsB.close();
  });

  it("does NOT deliver to clients not subscribed to the channel", async () => {
    const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});
    const ws = await connectWs(server, token);
    await waitForMessage(ws); // welcome

    // Subscribe to a DIFFERENT channel
    ws.send(JSON.stringify({ type: "subscribe", channel: "task:task-99" }));
    await waitForMessage(ws); // subscribed ack

    let messageReceived = false;
    ws.on("message", () => { messageReceived = true; });

    wsService.broadcast("company:co-1", {
      type: "task.status_changed",
      channel: "company:co-1",
      data: { companyId: "co-1", taskId: "t-1", status: "done" },
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(messageReceived).toBe(false);

    ws.close();
  });
});

describe("WsService — invalid message handling", () => {
  let server: http.Server;
  let wsService: WsService;
  let ws: WebSocket;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ server, wsService } = createTestServer());
    await listenServer(server);

    const token = await issueAccessToken("user-1", "co-1", ["oneops_admin"], {});
    ws = await connectWs(server, token);
    await waitForMessage(ws); // welcome
  });

  afterEach(async () => {
    ws.close();
    await wsService.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns an error for malformed JSON", async () => {
    ws.send("this is not json{{{");
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe("error");
  });

  it("returns an error for unknown message type", async () => {
    ws.send(JSON.stringify({ type: "launch_missiles" }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe("error");
  });
});
