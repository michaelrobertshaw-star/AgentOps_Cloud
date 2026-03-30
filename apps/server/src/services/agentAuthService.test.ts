import { describe, it, expect } from "vitest";
import { issueAgentRunToken, verifyAgentRunToken } from "./agentAuthService.js";

describe("agentAuthService", () => {
  describe("agent run tokens", () => {
    it("issues and verifies a valid run token", async () => {
      const token = await issueAgentRunToken("agent-1", "co-1", "dept-1", "test-agent");
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);

      const payload = await verifyAgentRunToken(token);
      expect(payload.sub).toBe("agent:agent-1");
      expect(payload.company_id).toBe("co-1");
      expect(payload.department_id).toBe("dept-1");
      expect(payload.agent_name).toBe("test-agent");
      expect(payload.scope).toBe("task_execution");
    });

    it("handles null department_id", async () => {
      const token = await issueAgentRunToken("agent-2", "co-1", null, "unscoped-agent");
      const payload = await verifyAgentRunToken(token);
      expect(payload.department_id).toBeNull();
    });

    it("rejects tampered tokens", async () => {
      const token = await issueAgentRunToken("agent-1", "co-1", "dept-1", "test-agent");
      const tampered = token.slice(0, -5) + "XXXXX";
      await expect(verifyAgentRunToken(tampered)).rejects.toThrow();
    });

    it("token contains expected fields", async () => {
      const token = await issueAgentRunToken("agent-1", "co-1", "dept-1", "test-agent");
      const payload = await verifyAgentRunToken(token);
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeDefined();
      expect(payload.exp).toBeGreaterThan(payload.iat);
      // 30 min expiry (±5 sec tolerance)
      expect(payload.exp - payload.iat).toBeGreaterThanOrEqual(1795);
      expect(payload.exp - payload.iat).toBeLessThanOrEqual(1805);
    });
  });
});
