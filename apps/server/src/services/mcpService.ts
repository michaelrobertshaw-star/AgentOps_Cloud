/**
 * MCP (Model Context Protocol) Service
 *
 * Lightweight MCP tool integration without the SDK dependency.
 * Connector config stores available tools statically and the HTTP
 * endpoint for runtime tool execution.
 *
 * Supports HTTP transport for tool calls. Stdio transport is defined
 * but not yet implemented at runtime.
 */

export interface McpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface McpToolResult {
  content: string;
  isError?: boolean;
}

export interface McpServerConfig {
  endpoint?: string;
  transport: "http" | "stdio";
  command?: string;
  args?: string[];
  tools: McpTool[];
}

/**
 * Call a tool on an MCP server via HTTP transport.
 * Sends POST to endpoint/tools/call with { name, arguments }.
 */
export async function callMcpTool(
  config: McpServerConfig,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<McpToolResult> {
  if (config.transport === "http" && config.endpoint) {
    const url = `${config.endpoint.replace(/\/$/, "")}/tools/call`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: toolName, arguments: toolArgs }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          content: `MCP tool error: ${res.status} ${errText.slice(0, 500)}`,
          isError: true,
        };
      }

      const data = (await res.json()) as {
        content?: Array<{ type: string; text: string }>;
        result?: string;
      };

      // MCP response format: { content: [{ type: "text", text: "..." }] }
      if (data.content && Array.isArray(data.content)) {
        return {
          content: data.content
            .map((c: { text?: string }) => c.text ?? "")
            .join("\n"),
        };
      }

      return { content: JSON.stringify(data) };
    } catch (err) {
      return {
        content: `MCP tool network error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  // For non-HTTP transports, return error
  return {
    content: `Transport "${config.transport}" not yet supported for runtime tool calls`,
    isError: true,
  };
}

/**
 * Parse MCP server config from a connector's config JSONB.
 */
export function parseMcpConfig(
  connectorConfig: Record<string, unknown>,
): McpServerConfig {
  return {
    endpoint:
      typeof connectorConfig.endpoint === "string"
        ? connectorConfig.endpoint
        : undefined,
    transport: connectorConfig.transport === "stdio" ? "stdio" : "http",
    command:
      typeof connectorConfig.command === "string"
        ? connectorConfig.command
        : undefined,
    args: Array.isArray(connectorConfig.args)
      ? (connectorConfig.args as string[])
      : [],
    tools: Array.isArray(connectorConfig.tools)
      ? (connectorConfig.tools as McpTool[])
      : [],
  };
}
