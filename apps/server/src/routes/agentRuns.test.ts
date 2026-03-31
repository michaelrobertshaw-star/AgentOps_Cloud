/**
 * Regression tests for agent run skill injection (ONE-81).
 *
 * Verifies:
 * 1. System prompt includes agent identity even when no skills are assigned.
 * 2. Skill content is injected when content.instructions is present.
 * 3. Skill content is injected when content.system is present.
 * 4. Skill content is injected when content.markdown is present (new format).
 * 5. Null skill.content is skipped without crashing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { issueAccessToken } from "../services/authService.js";

// ── Capture the system prompt passed to Claude ──────────────────────────────
let capturedSystemPrompt: string | undefined;

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = {
        stream: vi.fn(({ system }: { system: string }) => {
          capturedSystemPrompt = system;
          // Minimal async iterable that immediately ends
          const events: unknown[] = [];
          return {
            [Symbol.asyncIterator]: async function* () {
              for (const e of events) yield e;
            },
            finalMessage: async () => ({
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
          };
        }),
      };
    },
  };
});

// ── Configurable DB mock ─────────────────────────────────────────────────────
let mockAgent: Record<string, unknown> | null = null;
let mockAgentSkills: Array<{ skill: Record<string, unknown> }> = [];
let mockConnectors: unknown[] = [];

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    query: {
      agents: {
        findFirst: vi.fn(() => Promise.resolve(mockAgent)),
      },
      agentSkills: {
        findMany: vi.fn(() => Promise.resolve(mockAgentSkills)),
      },
      connectors: {
        findMany: vi.fn(() => Promise.resolve([])),
      },
      agentConnectors: {
        findMany: vi.fn(() => Promise.resolve([])),
      },
      companySettings: {
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
            {
              id: "run-1",
              companyId: "co-1",
              agentId: "agent-1",
              taskId: null,
              status: "running",
              input: { text: "hello" },
              model: "claude-sonnet-4-6",
              tokensInput: 0,
              tokensOutput: 0,
              costUsd: "0",
              durationMs: null,
              error: null,
              startedAt: new Date(),
              completedAt: null,
              createdAt: new Date(),
            },
          ]),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  }),
}));

vi.mock("./connectors.js", async () => {
  const { Router } = await import("express");
  return {
    loadAgentConnectorSecrets: vi.fn(() => Promise.resolve(mockConnectors)),
    connectorRoutes: vi.fn(() => Router()),
    agentConnectorRoutes: vi.fn(() => Router()),
  };
});

vi.mock("./usage.js", async () => {
  const { Router } = await import("express");
  return {
    checkSpendCap: vi.fn(() => Promise.resolve({ allowed: true })),
    usageRoutes: vi.fn(() => Router()),
  };
});

vi.mock("../middleware/audit.js", () => ({
  auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => {
    next();
  },
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/agents/:agentId/run — skill injection (ONE-81 regression)", () => {
  const app = createApp();
  let token: string;

  beforeEach(async () => {
    capturedSystemPrompt = undefined;
    mockConnectors = [];
    mockAgent = {
      id: "agent-1",
      companyId: "co-1",
      name: "QA Engineer",
      description: "Runs automated tests and validates deliverables.",
      type: "worker",
      status: "active",
    };
    mockAgentSkills = [];
    token = await issueAccessToken("user-1", "co-1", ["customer_admin"], {});
  });

  it("includes agent identity in system prompt when no skills assigned", async () => {
    mockAgentSkills = [];

    await request(app)
      .post("/api/agents/agent-1/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ input: "hello" });

    expect(capturedSystemPrompt).toContain("QA Engineer");
  });

  it("injects skill content.instructions into system prompt", async () => {
    mockAgentSkills = [
      {
        skill: {
          id: "skill-1",
          name: "browser-use",
          content: { instructions: "Use browser-use CLI to automate browsers." },
        },
      },
    ];

    await request(app)
      .post("/api/agents/agent-1/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ input: "test" });

    expect(capturedSystemPrompt).toContain("browser-use");
    expect(capturedSystemPrompt).toContain("Use browser-use CLI to automate browsers.");
  });

  it("injects skill content.system into system prompt", async () => {
    mockAgentSkills = [
      {
        skill: {
          id: "skill-2",
          name: "incident-handler",
          content: { system: "You respond to production incidents." },
        },
      },
    ];

    await request(app)
      .post("/api/agents/agent-1/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ input: "test" });

    expect(capturedSystemPrompt).toContain("You respond to production incidents.");
  });

  it("injects skill content.markdown into system prompt", async () => {
    mockAgentSkills = [
      {
        skill: {
          id: "skill-3",
          name: "my-skill",
          content: { markdown: "# My Skill\n\nDo the thing." },
        },
      },
    ];

    await request(app)
      .post("/api/agents/agent-1/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ input: "test" });

    expect(capturedSystemPrompt).toContain("# My Skill");
  });

  it("does NOT crash when skill.content is null", async () => {
    mockAgentSkills = [
      {
        skill: {
          id: "skill-4",
          name: "empty-skill",
          content: null,
        },
      },
    ];

    const res = await request(app)
      .post("/api/agents/agent-1/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ input: "test" });

    // Should not be a 500 — null content is skipped, agent still runs
    expect(res.status).not.toBe(500);
    // Agent identity should still appear
    expect(capturedSystemPrompt).toContain("QA Engineer");
  });

  it("includes agent description in system prompt", async () => {
    await request(app)
      .post("/api/agents/agent-1/run")
      .set("Authorization", `Bearer ${token}`)
      .send({ input: "describe yourself" });

    expect(capturedSystemPrompt).toContain("Runs automated tests and validates deliverables.");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/agents/agent-1/run")
      .send({ input: "hello" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when input is missing", async () => {
    const res = await request(app)
      .post("/api/agents/agent-1/run")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
