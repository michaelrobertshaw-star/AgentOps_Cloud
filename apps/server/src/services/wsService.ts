import http from "http";
import crypto from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { URL } from "url";
import Redis from "ioredis";
import pino from "pino";
import { getEnv } from "../config/env.js";
import { verifyAccessToken } from "./authService.js";
import type { JwtPayload } from "@agentops/shared";

const logger = pino({ name: "wsService" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WsEvent {
  type: string;
  channel: string;
  data: unknown;
  timestamp: string;
}

interface ClientMessage {
  type: "subscribe" | "unsubscribe" | "ping";
  channel?: string;
}

interface ConnectedClient {
  id: string;
  ws: WebSocket;
  userId: string;
  companyId: string;
  channels: Set<string>;
}

// Valid channel prefixes — used for access-control enforcement
const VALID_CHANNEL_PREFIXES = ["company:", "department:", "task:", "agent:"] as const;

function isValidChannel(channel: string): boolean {
  return VALID_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

function createRedisClient(): Redis {
  const env = getEnv();
  const url = new URL(env.REDIS_URL);
  return new Redis({
    host: url.hostname,
    port: Number(url.port) || 6379,
    lazyConnect: true,
  });
}

// ---------------------------------------------------------------------------
// WsService
// ---------------------------------------------------------------------------

export class WsService {
  private wss: WebSocketServer;
  private clients: Map<string, ConnectedClient> = new Map();
  private publisher: Redis;
  private subscriber: Redis;

  constructor(server: http.Server) {
    this.publisher = createRedisClient();
    this.subscriber = createRedisClient();

    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", this.handleConnection.bind(this));
    this.wss.on("error", (err) => {
      logger.error({ err }, "WebSocketServer error");
    });

    // Set up Redis pub/sub fan-out
    void this.setupRedisPubSub();
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    // Extract token from Authorization header only — never from URL query params
    // (tokens in URLs appear in access logs, browser history, and referrer headers)
    let token: string | undefined;

    const authHeader = req.headers["authorization"];
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }

    if (!token) {
      logger.warn("WebSocket connection rejected: no token provided");
      ws.close(4401, "Authentication required");
      return;
    }

    let payload: JwtPayload;
    try {
      payload = await verifyAccessToken(token);
    } catch {
      logger.warn("WebSocket connection rejected: invalid token");
      ws.close(4401, "Invalid or expired token");
      return;
    }

    const userId = payload.sub.replace("user:", "");
    const companyId = payload.company_id;
    const clientId = crypto.randomUUID();

    const client: ConnectedClient = {
      id: clientId,
      ws,
      userId,
      companyId,
      channels: new Set(),
    };

    this.clients.set(clientId, client);
    logger.info({ clientId, userId, companyId }, "WebSocket client connected");

    // Send welcome message
    this.send(ws, {
      type: "welcome",
      clientId,
      timestamp: new Date().toISOString(),
    });

    ws.on("message", (raw) => {
      this.handleMessage(client, raw.toString());
    });

    ws.on("close", () => {
      this.clients.delete(clientId);
      logger.info({ clientId }, "WebSocket client disconnected");
    });

    ws.on("error", (err) => {
      logger.error({ clientId, err }, "WebSocket client error");
    });
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private handleMessage(client: ConnectedClient, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(client.ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "ping":
        this.send(client.ws, { type: "pong" });
        break;

      case "subscribe": {
        const channel = msg.channel;
        if (!channel || !isValidChannel(channel)) {
          this.send(client.ws, { type: "error", message: "Invalid or missing channel" });
          return;
        }
        client.channels.add(channel);
        this.send(client.ws, { type: "subscribed", channel });
        logger.debug({ clientId: client.id, channel }, "Client subscribed");
        break;
      }

      case "unsubscribe": {
        const channel = msg.channel;
        if (!channel) {
          this.send(client.ws, { type: "error", message: "Missing channel" });
          return;
        }
        client.channels.delete(channel);
        this.send(client.ws, { type: "unsubscribed", channel });
        logger.debug({ clientId: client.id, channel }, "Client unsubscribed");
        break;
      }

      default:
        this.send(client.ws, { type: "error", message: "Unknown message type" });
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast
  // -------------------------------------------------------------------------

  /**
   * Broadcast an event to all local clients subscribed to the channel and
   * whose companyId matches the event's access scope.
   */
  broadcast(channel: string, event: WsEvent): void {
    // Also publish to Redis so other instances fan out
    void this.publisher.publish(
      `ws:${channel}`,
      JSON.stringify(event),
    );

    this.fanOutLocally(channel, event);
  }

  private fanOutLocally(channel: string, event: WsEvent): void {
    // Extract companyId from event data if present for access control
    const eventData = event.data as Record<string, unknown> | null | undefined;
    const eventCompanyId = eventData && typeof eventData === "object"
      ? (eventData["companyId"] as string | undefined)
      : undefined;

    for (const client of this.clients.values()) {
      if (!client.channels.has(channel)) continue;

      // Enforce company isolation: if the event carries a companyId, only
      // deliver to clients in that company.
      if (eventCompanyId && client.companyId !== eventCompanyId) continue;

      if (client.ws.readyState !== WebSocket.OPEN) continue;

      this.send(client.ws, {
        type: "event",
        channel: event.channel,
        eventType: event.type,
        data: event.data,
        timestamp: event.timestamp,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Redis pub/sub setup
  // -------------------------------------------------------------------------

  private async setupRedisPubSub(): Promise<void> {
    try {
      await this.subscriber.connect();
      await this.publisher.connect();

      // Subscribe to all ws:* channels using psubscribe (pattern subscribe)
      await this.subscriber.psubscribe("ws:*");

      this.subscriber.on("pmessage", (_pattern: string, redisChannel: string, message: string) => {
        // redisChannel = "ws:{channel}"
        const channel = redisChannel.replace(/^ws:/, "");
        let event: WsEvent;
        try {
          event = JSON.parse(message) as WsEvent;
        } catch {
          logger.warn({ redisChannel }, "Failed to parse Redis pub/sub message");
          return;
        }
        this.fanOutLocally(channel, event);
      });

      logger.info("Redis pub/sub connected for WebSocket fan-out");
    } catch (err) {
      logger.error({ err }, "Failed to connect Redis pub/sub for WebSocket — real-time events will be local-only");
    }
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  private send(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await this.subscriber.quit();
    await this.publisher.quit();
    logger.info("WsService shut down");
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _wsService: WsService | undefined;

export function createWsService(server: http.Server): WsService {
  if (_wsService) {
    throw new Error("WsService already created");
  }
  _wsService = new WsService(server);
  return _wsService;
}

export function getWsService(): WsService {
  if (!_wsService) {
    throw new Error("WsService not initialized — call createWsService(server) first");
  }
  return _wsService;
}

/**
 * Reset the singleton — only intended for use in tests.
 * Named with a leading underscore to signal it is not part of the public API.
 */
export function _resetForTest(): void {
  _wsService = undefined;
}
