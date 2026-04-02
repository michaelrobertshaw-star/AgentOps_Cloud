/**
 * Model Provider Adapters — unified interface for multi-model execution.
 *
 * Supported providers:
 *   - Anthropic (Claude API) — primary, uses @anthropic-ai/sdk
 *   - AWS Bedrock — uses fetch against Bedrock runtime API with SigV4
 *   - GCP Vertex AI — uses fetch against Vertex AI endpoint with OAuth2
 *
 * Each adapter implements the same streaming interface so the worker
 * doesn't need provider-specific logic.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createHmac, createHash } from "crypto";

// ── Common types ────────────────────────────────────────────────────────────

export interface ModelRequest {
  model: string;
  systemPrompt: string;
  userInput: string;
  maxTokens: number;
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  messages?: Array<{ role: "user" | "assistant"; content: string | Array<unknown> }>;
}

export type ModelChunk =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface ModelResult {
  output: string;
  tokensInput: number;
  tokensOutput: number;
  stopReason?: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

export interface ModelAdapter {
  stream(
    request: ModelRequest,
    onChunk: (chunk: ModelChunk) => void,
  ): Promise<ModelResult>;
}

// ── Provider detection ──────────────────────────────────────────────────────

export type ProviderType = "anthropic" | "aws_bedrock" | "gcp_vertex";

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  // AWS Bedrock
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
  // GCP Vertex
  gcpProjectId?: string;
  gcpLocation?: string;
  gcpServiceAccountJson?: string;
}

export function createAdapter(config: ProviderConfig): ModelAdapter {
  switch (config.type) {
    case "anthropic":
      return new AnthropicAdapter(config.apiKey ?? "");
    case "aws_bedrock":
      return new BedrockAdapter(config);
    case "gcp_vertex":
      return new VertexAdapter(config);
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

// ── Cost calculation ────────────────────────────────────────────────────────

const MODEL_RATES: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Anthropic direct
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-5-20251001": { inputPer1M: 0.80, outputPer1M: 4.0 },
  // Bedrock model IDs
  "anthropic.claude-3-5-sonnet-20241022-v2:0": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "anthropic.claude-3-haiku-20240307-v1:0": { inputPer1M: 0.25, outputPer1M: 1.25 },
  "anthropic.claude-sonnet-4-6-v1:0": { inputPer1M: 3.0, outputPer1M: 15.0 },
  // Vertex model IDs
  "claude-sonnet-4-6@20250514": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-5@20251001": { inputPer1M: 0.80, outputPer1M: 4.0 },
};

const MODEL_MAX_TOKENS: Record<string, number> = {
  "claude-sonnet-4-6": 8096,
  "claude-haiku-4-5-20251001": 8192,
  "anthropic.claude-3-5-sonnet-20241022-v2:0": 8096,
  "anthropic.claude-3-haiku-20240307-v1:0": 4096,
  "anthropic.claude-sonnet-4-6-v1:0": 8096,
  "claude-sonnet-4-6@20250514": 8096,
  "claude-haiku-4-5@20251001": 8192,
};

export function getModelMaxTokens(model: string): number {
  return MODEL_MAX_TOKENS[model] ?? 4096;
}

export function calcCost(model: string, tokensIn: number, tokensOut: number): number {
  const rates = MODEL_RATES[model] ?? { inputPer1M: 3.0, outputPer1M: 15.0 };
  return (tokensIn / 1_000_000) * rates.inputPer1M + (tokensOut / 1_000_000) * rates.outputPer1M;
}

// ── Anthropic Adapter ───────────────────────────────────────────────────────

class AnthropicAdapter implements ModelAdapter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async stream(request: ModelRequest, onChunk: (chunk: ModelChunk) => void): Promise<ModelResult> {
    let fullOutput = "";
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    const messages = request.messages ?? [{ role: "user" as const, content: request.userInput }];

    const apiParams: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.systemPrompt,
      messages,
    };

    if (request.tools && request.tools.length > 0) {
      apiParams.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    const stream = await this.client.messages.stream(apiParams as any);

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullOutput += event.delta.text;
        onChunk({ type: "text", text: event.delta.text });
      }
    }

    const finalMessage = await stream.finalMessage();

    // Extract tool_use blocks from final message
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
        onChunk({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      output: fullOutput,
      tokensInput: finalMessage.usage?.input_tokens ?? 0,
      tokensOutput: finalMessage.usage?.output_tokens ?? 0,
      stopReason: finalMessage.stop_reason ?? undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}

// ── AWS Bedrock Adapter ─────────────────────────────────────────────────────

class BedrockAdapter implements ModelAdapter {
  private accessKeyId: string;
  private secretAccessKey: string;
  private region: string;

  constructor(config: ProviderConfig) {
    this.accessKeyId = config.awsAccessKeyId ?? "";
    this.secretAccessKey = config.awsSecretAccessKey ?? "";
    this.region = config.awsRegion ?? "us-east-1";
  }

  async stream(request: ModelRequest, onChunk: (chunk: ModelChunk) => void): Promise<ModelResult> {
    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: request.maxTokens,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userInput }],
    });

    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const path = `/model/${request.model}/invoke`;
    const url = `https://${host}${path}`;

    const headers = this.signRequest("POST", host, path, body);

    console.log(`[BedrockAdapter] Invoking ${request.model} in ${this.region}`);

    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Bedrock API ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json() as {
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    const output = data.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("");

    onChunk({ type: "text", text: output });

    return {
      output,
      tokensInput: data.usage?.input_tokens ?? 0,
      tokensOutput: data.usage?.output_tokens ?? 0,
    };
  }

  private signRequest(method: string, host: string, path: string, body: string): Record<string, string> {
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, "").slice(0, 8);
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const service = "bedrock";
    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;

    const payloadHash = createHash("sha256").update(body).digest("hex");

    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

    const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const canonicalRequestHash = createHash("sha256").update(canonicalRequest).digest("hex");

    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, canonicalRequestHash].join("\n");

    const signingKey = this.getSignatureKey(dateStamp);
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      Authorization: authorization,
      "X-Amz-Date": amzDate,
      "X-Amz-Content-Sha256": payloadHash,
      Host: host,
    };
  }

  private getSignatureKey(dateStamp: string): Buffer {
    const kDate = createHmac("sha256", `AWS4${this.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = createHmac("sha256", kDate).update(this.region).digest();
    const kService = createHmac("sha256", kRegion).update("bedrock").digest();
    return createHmac("sha256", kService).update("aws4_request").digest();
  }
}

// ── GCP Vertex AI Adapter ───────────────────────────────────────────────────

class VertexAdapter implements ModelAdapter {
  private projectId: string;
  private location: string;
  private serviceAccountJson: string;

  constructor(config: ProviderConfig) {
    this.projectId = config.gcpProjectId ?? "";
    this.location = config.gcpLocation ?? "us-central1";
    this.serviceAccountJson = config.gcpServiceAccountJson ?? "";
  }

  async stream(request: ModelRequest, onChunk: (chunk: ModelChunk) => void): Promise<ModelResult> {
    const accessToken = await this.getAccessToken();

    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/anthropic/models/${request.model}:rawPredict`;

    const body = JSON.stringify({
      anthropic_version: "vertex-2023-10-16",
      max_tokens: request.maxTokens,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userInput }],
    });

    console.log(`[VertexAdapter] Invoking ${request.model} in ${this.location}`);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Vertex API ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json() as {
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    const output = data.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("");

    onChunk({ type: "text", text: output });

    return {
      output,
      tokensInput: data.usage?.input_tokens ?? 0,
      tokensOutput: data.usage?.output_tokens ?? 0,
    };
  }

  private async getAccessToken(): Promise<string> {
    if (!this.serviceAccountJson) {
      throw new Error("GCP service account JSON is required for Vertex AI");
    }

    const sa = JSON.parse(this.serviceAccountJson) as {
      client_email: string;
      private_key: string;
      token_uri: string;
    };

    // Build JWT for service account
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    })).toString("base64url");

    const { createSign } = await import("crypto");
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(sa.private_key, "base64url");

    const jwt = `${header}.${payload}.${signature}`;

    // Exchange JWT for access token
    const tokenRes = await fetch(sa.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`GCP token exchange failed ${tokenRes.status}: ${errText.slice(0, 200)}`);
    }

    const tokenData = await tokenRes.json() as { access_token: string };
    return tokenData.access_token;
  }
}
