/**
 * Tool Execution Service
 *
 * Core execution engine for platform tools. Handles:
 * - Loading tool + connector from DB
 * - Decrypting connector secrets
 * - Transforming input via field_mapping (dot-notation)
 * - Making HTTP requests with Basic auth
 * - Logging executions to tool_executions table
 */

import { eq, and, sql } from "drizzle-orm";
import { tools, toolExecutions, connectors } from "@agentops/db";
import { getDb } from "../lib/db.js";
import { decryptSecrets } from "../routes/connectors.js";
import type { EncryptedPayload } from "../routes/connectors.js";

// ================================================================
// Types
// ================================================================

export interface ToolExecutionResult {
  success: boolean;
  response: unknown;
  executionId: string;
  durationMs: number;
  error?: string;
}

interface ToolRow {
  id: string;
  connectorId: string;
  companyId: string;
  name: string;
  displayName: string;
  description: string;
  inputSchema: unknown;
  httpMethod: string | null;
  endpointPath: string;
  fieldMapping: Record<string, string>;
  responseMapping: Record<string, string>;
  staticParams: Record<string, unknown>;
}

interface ConnectorRow {
  id: string;
  config: Record<string, unknown>;
  secretsEncrypted: EncryptedPayload | null;
}

// ================================================================
// Field mapping: dot-notation transformer
// ================================================================

/**
 * Transforms flat input using dot-notation field mapping into nested objects.
 *
 * Example:
 *   input: { pickup_lat: 53.3, pickup_lng: -6.2 }
 *   mapping: { pickup_lat: "address.lat", pickup_lng: "address.lng" }
 *   result: { address: { lat: 53.3, lng: -6.2 } }
 */
export function transformInput(
  input: Record<string, unknown>,
  fieldMapping: Record<string, string>,
  staticParams: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...staticParams };

  for (const [inputKey, targetPath] of Object.entries(fieldMapping)) {
    if (!(inputKey in input)) continue;
    const value = input[inputKey];
    setNestedValue(result, targetPath, value);
  }

  // Pass through any input fields not in the mapping
  for (const [key, value] of Object.entries(input)) {
    if (!(key in fieldMapping)) {
      result[key] = value;
    }
  }

  return result;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

// ================================================================
// Core execution function
// ================================================================

export async function executeTool(
  toolId: string,
  companyId: string,
  input: Record<string, unknown>,
  agentId?: string,
  agentRunId?: string,
): Promise<ToolExecutionResult> {
  const db = getDb();
  const startMs = Date.now();

  // 1. Load tool from DB
  const toolRows = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, toolId), eq(tools.companyId, companyId)))
    .limit(1);

  if (toolRows.length === 0) {
    throw new Error(`Tool ${toolId} not found`);
  }

  const tool = toolRows[0] as unknown as ToolRow;

  // 2. Load connector — SECURITY: also filter by companyId to prevent cross-tenant access
  const connectorRows = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.id, tool.connectorId), eq(connectors.companyId, companyId)))
    .limit(1);

  if (connectorRows.length === 0) {
    throw new Error(`Connector ${tool.connectorId} not found or does not belong to company`);
  }

  const connector = connectorRows[0] as unknown as ConnectorRow;

  // 3. Decrypt connector secrets
  let secrets: Record<string, string> = {};
  if (connector.secretsEncrypted) {
    secrets = decryptSecrets(connector.secretsEncrypted);
  }

  // 4. Get base_url from secrets or config
  const baseUrl =
    secrets.base_url ||
    (connector.config?.base_url as string) ||
    "";

  if (!baseUrl) {
    throw new Error(`No base_url configured for connector ${tool.connectorId}`);
  }

  // 5. Transform input using field_mapping
  const mappedParams = transformInput(
    input,
    tool.fieldMapping || {},
    tool.staticParams || {},
  );

  // 6. Build URL
  const cleanBase = baseUrl.replace(/\/+$/, "");
  // Substitute {param} placeholders in endpoint path with values from input
  // Track which params were used in path substitution so we don't duplicate them in query string
  const pathSubstitutedParams = new Set<string>();
  let cleanPath = tool.endpointPath.replace(/^\/+/, "");
  cleanPath = cleanPath.replace(/\{(\w+)\}/g, (_match, paramName) => {
    const val = input[paramName];
    if (val !== undefined && val !== null) {
      pathSubstitutedParams.add(paramName);
      return encodeURIComponent(String(val));
    }
    return `{${paramName}}`;
  });
  let url = `${cleanBase}/${cleanPath}`;

  // 6b. For GET/HEAD requests, append mapped params as query string
  // Exclude params already used in URL path substitution to avoid duplication
  if ((tool.httpMethod || "POST").toUpperCase() === "GET" || (tool.httpMethod || "POST").toUpperCase() === "HEAD") {
    const qsEntries = Object.entries(mappedParams).filter(
      ([k, v]) => v !== "" && v != null && v !== undefined && !pathSubstitutedParams.has(k)
    );
    if (qsEntries.length > 0) {
      const qs = qsEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
      url += (url.includes("?") ? "&" : "?") + qs;
    }
  }

  // 7. Build auth header (Basic auth: api_key:account_id)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const apiKey = secrets.api_key || "";
  // Support both field names: account_id (iCabbi convention) and secret_key (generic REST)
  const accountId = secrets.account_id || secrets.secret_key || "";
  const authType = (connector.config?.auth_type as string) || "bearer";

  if (apiKey) {
    if (authType === "basic") {
      const credentials = Buffer.from(`${apiKey}:${accountId}`).toString("base64");
      headers["Authorization"] = `Basic ${credentials}`;
      console.log(`[ToolExec] Basic auth: key=${apiKey.slice(0, 4)}..., account=${accountId.slice(0, 4)}...`);
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  } else {
    console.log(`[ToolExec] WARNING: No api_key found in secrets. Keys available: ${Object.keys(secrets).join(", ")}`);
  }

  // 8. Make HTTP request
  let responseRaw: unknown = null;
  let status: string = "success";
  let errorMessage: string | undefined;

  try {
    const method = (tool.httpMethod || "POST").toUpperCase();
    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (method !== "GET" && method !== "HEAD") {
      fetchOptions.body = JSON.stringify(mappedParams);
    }

    console.log(`[ToolExec] ${method} ${url}`);
    console.log(`[ToolExec] Payload:`, JSON.stringify(mappedParams, null, 2));
    const response = await fetch(url, fetchOptions);
    const responseText = await response.text();
    console.log(`[ToolExec] Response ${response.status}:`, responseText.slice(0, 500));

    try {
      responseRaw = JSON.parse(responseText);
    } catch {
      responseRaw = { raw: responseText };
    }

    if (!response.ok) {
      status = "error";
      errorMessage = `HTTP ${response.status}: ${responseText.slice(0, 500)}`;
    }
  } catch (err) {
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    responseRaw = { error: errorMessage };
  }

  const durationMs = Date.now() - startMs;

  // 9. Log to tool_executions table
  const [execution] = await db
    .insert(toolExecutions)
    .values({
      toolId,
      agentId: agentId || "00000000-0000-0000-0000-000000000000",
      agentRunId: agentRunId || null,
      companyId,
      inputParams: input,
      mappedParams,
      responseRaw,
      responseMapped: responseRaw, // TODO: apply response_mapping transform
      status,
      errorMessage: errorMessage || null,
      durationMs,
    })
    .returning();

  // 10. Return result
  return {
    success: status === "success",
    response: responseRaw,
    executionId: execution.id,
    durationMs,
    error: errorMessage,
  };
}
