import { Router } from "express";
import { eq } from "drizzle-orm";
import { agents } from "@agentops/db";
import { authenticateAgent, issueAgentRunToken, verifyAgentRunToken } from "../services/agentAuthService.js";
import { recordHeartbeat, recordTaskRunHeartbeat } from "../services/heartbeatService.js";
import { getDb } from "../lib/db.js";
import { UnauthorizedError } from "../lib/errors.js";

export function agentCheckinRoutes() {
  const router = Router();

  /**
   * POST /agent/checkin
   * Agent presents its API key, receives a short-lived run token.
   * No user auth required — the API key IS the auth.
   *
   * Headers: X-Agent-Key: ak_<hex>
   * Response: { agent, runToken, expiresIn }
   */
  router.post("/checkin", async (req, res, next) => {
    try {
      const apiKey = req.headers["x-agent-key"] as string | undefined;
      if (!apiKey) {
        throw new UnauthorizedError("Missing X-Agent-Key header");
      }

      const { agent } = await authenticateAgent(apiKey);

      // Update heartbeat timestamp
      const db = getDb();
      await db
        .update(agents)
        .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(agents.id, agent.id));

      // Issue run token
      const runToken = await issueAgentRunToken(
        agent.id,
        agent.companyId,
        agent.departmentId,
        agent.name,
      );

      res.json({
        agent: {
          id: agent.id,
          name: agent.name,
          type: agent.type,
          status: agent.status,
          departmentId: agent.departmentId,
          executionPolicy: agent.executionPolicy,
        },
        runToken,
        expiresIn: 1800,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /agent/heartbeat
   * Agent sends periodic heartbeats using its run token.
   *
   * Headers: Authorization: Bearer <runToken>
   * Body (optional): { runId?: string }
   * Response: { ok: true, timestamp }
   */
  router.post("/heartbeat", async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        throw new UnauthorizedError("Missing or invalid Authorization header");
      }

      const token = header.slice(7);
      const payload = await verifyAgentRunToken(token).catch(() => {
        throw new UnauthorizedError("Invalid or expired run token");
      });

      const agentId = payload.sub.replace("agent:", "");
      await recordHeartbeat(agentId, payload.company_id);

      // If a specific run is provided, update run heartbeat too
      if (req.body?.runId) {
        await recordTaskRunHeartbeat(req.body.runId);
      }

      res.json({ ok: true, timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
