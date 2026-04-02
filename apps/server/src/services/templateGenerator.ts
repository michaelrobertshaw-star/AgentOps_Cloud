/**
 * AI-Generated Pipeline Templates (Phase 4b)
 *
 * Uses Claude (Haiku for cost efficiency) to generate structured agent
 * template configurations from natural language descriptions.
 */

import Anthropic from "@anthropic-ai/sdk";
import { loadCompanyDefaultApiKey } from "../routes/connectors.js";

export interface GeneratedTemplate {
  name: string;
  description: string;
  tier: "simple" | "rag" | "autonomous" | "enterprise";
  layerConfig: {
    infrastructure?: string;
    model?: string;
    data?: string[];
    orchestration?: string[];
    application?: string;
  };
  defaultAgentConfig: Record<string, unknown>;
}

const SYSTEM_PROMPT = `You are an AI agent configuration generator. Given a natural language description of what an agent should do, generate a structured template configuration.

Available tiers: simple, rag, autonomous, enterprise
Available models: claude-sonnet-4-6, claude-haiku-4-5-20251001
Available infrastructure connectors: claude_api, aws_bedrock, gcp_vertex
Available data connectors: vector_db, postgres_db, pdf_docs, rest_api
Available routing policies: cost_sensitive, speed_optimized, accuracy_first
Available application types: worker, assistant, analyst, monitor

Respond with ONLY a JSON object (no markdown, no explanation) matching this exact shape:
{
  "name": "Agent Name",
  "description": "What the agent does",
  "tier": "simple|rag|autonomous|enterprise",
  "layerConfig": {
    "infrastructure": "claude_api",
    "model": "model-id",
    "data": ["connector-types"],
    "orchestration": [],
    "application": "agent-type"
  },
  "defaultAgentConfig": {
    "preferred_model": "model-id",
    "routing_policy": "policy",
    "rag_enabled": true/false
  }
}

Guidelines:
- If the description mentions knowledge, documents, or data lookup, enable RAG and set tier to "rag" or higher
- If the description mentions autonomous operation or multi-step tasks, set tier to "autonomous"
- For simple Q&A or assistance, use "simple" tier
- Default to claude_api infrastructure and claude-sonnet-4-6 model unless cost is mentioned
- If cost efficiency is mentioned, use claude-haiku-4-5-20251001 and cost_sensitive routing`;

export async function generateTemplate(
  description: string,
  companyId?: string,
): Promise<GeneratedTemplate> {
  let apiKey = process.env.ANTHROPIC_API_KEY ?? "";

  // Try to load API key from company's default claude_api connector
  if (!apiKey && companyId) {
    apiKey = await loadCompanyDefaultApiKey(companyId);
  }

  if (!apiKey) {
    throw new Error("No API key available. Go to Admin > Connectors and add a claude_api connector with your Anthropic API key, or set ANTHROPIC_API_KEY as an environment variable.");
  }

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: process.env.TEMPLATE_GENERATOR_MODEL ?? "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Generate an agent template for: ${description}`,
      },
    ],
  });

  let text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  // Strip markdown code fences if present
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }

  // Parse and validate
  const parsed = JSON.parse(text);

  if (!parsed.name || !parsed.tier || !parsed.layerConfig) {
    throw new Error("Generated template missing required fields");
  }

  const validTiers = ["simple", "rag", "autonomous", "enterprise"];
  if (!validTiers.includes(parsed.tier)) {
    throw new Error(`Invalid tier "${parsed.tier}" in generated template`);
  }

  return parsed as GeneratedTemplate;
}
