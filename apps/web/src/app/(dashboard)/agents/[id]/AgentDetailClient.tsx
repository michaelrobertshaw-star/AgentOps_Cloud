"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchWithTenant } from "@/lib/fetchWithTenant";
import WorkspaceTab from "./WorkspaceTab";

interface Agent {
  id: string;
  name: string;
  type: string;
  version: string | null;
  status: string;
  description: string | null;
  deployedAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  config: Record<string, unknown> | null;
}

interface AgentSkill {
  id: string;
  name: string;
  description: string | null;
  urlKey: string;
}

interface KnowledgeChunk {
  id: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface AgentUsageSummary {
  runCount: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  avgDurationMs: number;
}

interface DailyPoint {
  date: string;
  runCount: number;
  costUsd: number;
}

function AgentStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-600",
    testing: "bg-yellow-100 text-yellow-700",
    tested: "bg-blue-100 text-blue-700",
    deployed: "bg-green-100 text-green-700",
    disabled: "bg-red-100 text-red-700",
    active: "bg-green-100 text-green-700",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
        map[status] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {status}
    </span>
  );
}

/** Minimal SVG sparkline chart */
function SparklineChart({ data, width = 400, height = 80 }: { data: DailyPoint[]; width?: number; height?: number }) {
  if (data.length === 0) {
    return <div className="h-20 flex items-center justify-center text-xs text-gray-300">No data</div>;
  }
  const maxCost = Math.max(...data.map((d) => d.costUsd), 0.0001);
  const pts = data.map((d, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * (width - 20) + 10;
    const y = height - 10 - ((d.costUsd / maxCost) * (height - 20));
    return `${x},${y}`;
  });
  const polyline = pts.join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <polyline points={polyline} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinejoin="round" />
      {data.map((d, i) => {
        const [x, y] = pts[i].split(",").map(Number);
        return (
          <circle key={i} cx={x} cy={y} r="3" fill="#6366f1">
            <title>{`${d.date}: $${d.costUsd.toFixed(4)} (${d.runCount} runs)`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

export function AgentDetailClient({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"details" | "run" | "usage" | "skills" | "knowledge" | "tools" | "workspace" | "memories" | "mcp">("details");

  // Run agent state
  const [runInput, setRunInput] = useState("");
  const [runLoading, setRunLoading] = useState(false);
  const [runResult, setRunResult] = useState<{ runId: string; status: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Stop agent state
  const [showStopModal, setShowStopModal] = useState(false);
  const [stopReason, setStopReason] = useState("");
  const [stopLoading, setStopLoading] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  // Skills state
  const [assignedSkills, setAssignedSkills] = useState<AgentSkill[]>([]);
  const [companySkills, setCompanySkills] = useState<AgentSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [skillActionLoading, setSkillActionLoading] = useState(false);

  // Usage state
  const [usageSummary, setUsageSummary] = useState<AgentUsageSummary | null>(null);
  const [dailyData, setDailyData] = useState<DailyPoint[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);

  // Knowledge state
  const [knowledgeChunks, setKnowledgeChunks] = useState<KnowledgeChunk[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [knowledgeText, setKnowledgeText] = useState("");
  const [knowledgeSourceName, setKnowledgeSourceName] = useState("");
  const [knowledgeSubmitting, setKnowledgeSubmitting] = useState(false);
  const [knowledgeDeleting, setKnowledgeDeleting] = useState(false);

  // MCP state
  interface McpConnector {
    id: string;
    name: string;
    type: string;
    config: { endpoint?: string; transport?: string; tools?: Array<{ name: string; description: string; input_schema?: Record<string, unknown> }> };
  }
  const [mcpConnectors, setMcpConnectors] = useState<McpConnector[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  // Tools marketplace state
  interface ToolItem {
    id: string;
    name: string;
    displayName: string;
    description: string;
    httpMethod: string;
    endpointPath: string;
    inputSchema: Record<string, unknown>;
    connectorId: string;
    connectorName?: string;
    connectorType?: string;
    enabled: boolean;
  }
  interface ConnectorWithTools {
    id: string;
    name: string;
    type: string;
    description: string | null;
    tools: ToolItem[];
    attached: boolean;
  }
  const [toolsMarketplace, setToolsMarketplace] = useState<ConnectorWithTools[]>([]);
  const [attachedConnectorIds, setAttachedConnectorIds] = useState<Set<string>>(new Set());
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsAttaching, setToolsAttaching] = useState<string | null>(null);

  // Map It! state
  interface MappingConfidence {
    input: string;
    api: string;
    score: number;
    reason: string;
  }
  interface ApiField {
    path: string;
    type: string;
    sample: unknown;
  }
  const [mapItOpen, setMapItOpen] = useState(false);
  const [mapItSamplePayload, setMapItSamplePayload] = useState("");
  const [mapItSampleResponse, setMapItSampleResponse] = useState("");
  const [mapItDescription, setMapItDescription] = useState("");
  const [mapItApiDocs, setMapItApiDocs] = useState("");
  const [mapItLoading, setMapItLoading] = useState(false);
  const [mapItError, setMapItError] = useState<string | null>(null);
  const [mapItResult, setMapItResult] = useState<{
    apiFields: ApiField[];
    inputSchema: Record<string, unknown>;
    fieldMapping: Record<string, string>;
    responseMapping: Record<string, string>;
    confidence: MappingConfidence[];
    responseFields?: Array<{ apiField: string; friendlyName: string; description: string }>;
  } | null>(null);
  const [mapItEditingMapping, setMapItEditingMapping] = useState<Record<string, string>>({});
  // Memories state
  interface Memory {
    id: string;
    category: string;
    title: string;
    content: string;
    source: string;
    tags: string[];
    upvotes: number;
    agent_name: string | null;
    created_at: string;
  }
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [memoriesError, setMemoriesError] = useState<string | null>(null);

  const [mapItSaving, setMapItSaving] = useState(false);
  const [mapItToolName, setMapItToolName] = useState("");
  const [mapItEndpointPath, setMapItEndpointPath] = useState("");
  const [mapItHttpMethod, setMapItHttpMethod] = useState("POST");
  const [mapItConnectorId, setMapItConnectorId] = useState("");

  async function handleMapIt() {
    setMapItLoading(true);
    setMapItError(null);
    setMapItResult(null);
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(mapItSamplePayload);
      } catch {
        throw new Error("Invalid JSON — paste a sample API payload");
      }
      let parsedResponse: Record<string, unknown> | undefined;
      if (mapItSampleResponse.trim()) {
        try {
          parsedResponse = JSON.parse(mapItSampleResponse);
        } catch {
          throw new Error("Invalid JSON in response sample");
        }
      }
      const res = await fetchWithTenant("/api/tools/auto-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          samplePayload: parsed,
          sampleResponse: parsedResponse,
          toolDescription: mapItDescription || undefined,
          apiDocs: mapItApiDocs || undefined,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        const errMsg = typeof b.error === "string" ? b.error : typeof b.error?.message === "string" ? b.error.message : `HTTP ${res.status}: ${JSON.stringify(b)}`;
        throw new Error(errMsg);
      }
      const data = await res.json();
      setMapItResult(data);
      setMapItEditingMapping(data.fieldMapping ?? {});
      // Auto-populate tool name from description
      if (mapItDescription && !mapItToolName) setMapItToolName(mapItDescription);
      // Try to extract endpoint from API docs
      if (mapItApiDocs && !mapItEndpointPath) {
        const endpointMatch = mapItApiDocs.match(/(?:post|get|put|patch|delete)\s+\/([\w/{}]+)/i);
        if (endpointMatch) {
          setMapItEndpointPath(endpointMatch[1]);
          const methodMatch = mapItApiDocs.match(/^(post|get|put|patch|delete)\s/im);
          if (methodMatch) setMapItHttpMethod(methodMatch[1].toUpperCase());
        }
      }
    } catch (e) {
      setMapItError(e instanceof Error ? e.message : typeof e === "string" ? e : "Mapping failed");
    } finally {
      setMapItLoading(false);
    }
  }

  async function handleSaveAsTool() {
    if (!mapItResult || !mapItToolName.trim() || !mapItEndpointPath.trim() || !mapItConnectorId) return;
    setMapItSaving(true);
    setMapItError(null);
    try {
      const toolName = mapItToolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const res = await fetchWithTenant("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectorId: mapItConnectorId,
          name: toolName,
          displayName: mapItToolName.trim(),
          description: mapItDescription || mapItToolName.trim(),
          httpMethod: mapItHttpMethod,
          endpointPath: mapItEndpointPath.trim(),
          inputSchema: mapItResult.inputSchema,
          fieldMapping: mapItEditingMapping,
          responseMapping: mapItResult.responseMapping ?? {},
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        const errMsg = typeof b.error === "string" ? b.error : typeof b.error?.message === "string" ? b.error.message : `HTTP ${res.status}`;
        throw new Error(errMsg);
      }
      // Tool created — now attach the connector to this agent if not already attached
      if (!attachedConnectorIds.has(mapItConnectorId)) {
        await fetchWithTenant(`/api/agents/${agentId}/connectors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectorId: mapItConnectorId }),
        });
      }
      setMapItOpen(false);
      setMapItResult(null);
      await fetchTools();
    } catch (e) {
      setMapItError(e instanceof Error ? e.message : "Failed to save tool");
    } finally {
      setMapItSaving(false);
    }
  }

  const fetchMemories = useCallback(async () => {
    setMemoriesLoading(true);
    setMemoriesError(null);
    try {
      const res = await fetchWithTenant("/api/memories");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMemories(await res.json());
    } catch (e) {
      setMemoriesError(e instanceof Error ? e.message : "Failed to load memories");
    } finally {
      setMemoriesLoading(false);
    }
  }, []);

  async function handleUpvoteMemory(memoryId: string) {
    try {
      await fetchWithTenant(`/api/memories/${memoryId}/upvote`, { method: "POST" });
      setMemories((prev) => prev.map((m) => m.id === memoryId ? { ...m, upvotes: m.upvotes + 1 } : m));
    } catch { /* silent */ }
  }

  async function handleDeleteMemory(memoryId: string) {
    if (!confirm("Delete this memory?")) return;
    try {
      await fetchWithTenant(`/api/memories/${memoryId}`, { method: "DELETE" });
      setMemories((prev) => prev.filter((m) => m.id !== memoryId));
    } catch { /* silent */ }
  }

  const fetchAgent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Agent;
      setAgent(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load agent");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  const fetchSkills = useCallback(async () => {
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const [assignedRes, companyRes] = await Promise.all([
        fetchWithTenant(`/api/agents/${agentId}/skills`),
        fetchWithTenant(`/api/skills`),
      ]);
      if (assignedRes.ok) setAssignedSkills(await assignedRes.json());
      if (companyRes.ok) setCompanySkills(await companyRes.json());
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : "Failed to load skills");
    } finally {
      setSkillsLoading(false);
    }
  }, [agentId]);

  async function handleAddSkill() {
    if (!selectedSkillId) return;
    setSkillActionLoading(true);
    setSkillsError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: selectedSkillId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setSelectedSkillId("");
      await fetchSkills();
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : "Failed to add skill");
    } finally {
      setSkillActionLoading(false);
    }
  }

  async function handleRemoveSkill(skillId: string) {
    setSkillActionLoading(true);
    setSkillsError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/skills/${skillId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await fetchSkills();
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : "Failed to remove skill");
    } finally {
      setSkillActionLoading(false);
    }
  }

  const fetchUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const monthStart = new Date();
      monthStart.setDate(1);
      const from = monthStart.toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const params = new URLSearchParams({ from, to, agentId });

      const [byAgentRes, dailyRes] = await Promise.all([
        fetchWithTenant(`/api/usage/by-agent?${params}`),
        fetchWithTenant(`/api/usage/daily?${params}`),
      ]);

      if (byAgentRes.ok) {
        const rows = await byAgentRes.json() as Array<{
          agentId: string;
          runCount: number;
          tokensInput: number;
          tokensOutput: number;
          costUsd: number;
          avgDurationMs: number;
        }>;
        const row = rows.find((r) => r.agentId === agentId);
        if (row) {
          setUsageSummary({
            runCount: row.runCount,
            tokensInput: row.tokensInput,
            tokensOutput: row.tokensOutput,
            costUsd: row.costUsd,
            avgDurationMs: row.avgDurationMs,
          });
        } else {
          setUsageSummary({ runCount: 0, tokensInput: 0, tokensOutput: 0, costUsd: 0, avgDurationMs: 0 });
        }
      }

      if (dailyRes.ok) {
        setDailyData(await dailyRes.json());
      }
    } finally {
      setUsageLoading(false);
    }
  }, [agentId]);

  const fetchKnowledge = useCallback(async () => {
    setKnowledgeLoading(true);
    setKnowledgeError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/knowledge`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setKnowledgeChunks(await res.json());
    } catch (e) {
      setKnowledgeError(e instanceof Error ? e.message : "Failed to load knowledge");
    } finally {
      setKnowledgeLoading(false);
    }
  }, [agentId]);

  const fetchMcp = useCallback(async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/connectors`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const allConnectors = (await res.json()) as McpConnector[];
      setMcpConnectors(allConnectors.filter((c) => c.type === "mcp_server"));
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : "Failed to load MCP connectors");
    } finally {
      setMcpLoading(false);
    }
  }, [agentId]);

  const fetchTools = useCallback(async () => {
    setToolsLoading(true);
    setToolsError(null);
    try {
      // Fetch all connectors, all tools, and attached connectors in parallel
      const [connectorsRes, toolsRes, attachedRes] = await Promise.all([
        fetchWithTenant("/api/connectors"),
        fetchWithTenant("/api/tools"),
        fetchWithTenant(`/api/agents/${agentId}/connectors`),
      ]);
      if (!connectorsRes.ok || !toolsRes.ok || !attachedRes.ok) throw new Error("Failed to load");

      const allConnectors = (await connectorsRes.json()) as Array<{ id: string; name: string; type: string; description: string | null }>;
      const allTools = (await toolsRes.json()) as ToolItem[];
      const attached = (await attachedRes.json()) as Array<{ id: string }>;

      const attachedIds = new Set(attached.map((c) => c.id));
      setAttachedConnectorIds(attachedIds);

      // Group tools by connector, include connectors that have tools
      const connectorsWithTools: ConnectorWithTools[] = allConnectors
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          description: c.description,
          tools: allTools.filter((t) => t.connectorId === c.id),
          attached: attachedIds.has(c.id),
        }))
        .filter((c) => c.tools.length > 0 || c.type === "rest_api" || c.type === "mcp_server");

      // Sort: attached first, then by name
      connectorsWithTools.sort((a, b) => {
        if (a.attached && !b.attached) return -1;
        if (!a.attached && b.attached) return 1;
        return a.name.localeCompare(b.name);
      });

      setToolsMarketplace(connectorsWithTools);
    } catch (e) {
      setToolsError(e instanceof Error ? e.message : "Failed to load tools");
    } finally {
      setToolsLoading(false);
    }
  }, [agentId]);

  async function handleAttachConnector(connectorId: string) {
    setToolsAttaching(connectorId);
    setToolsError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/connectors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectorId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await fetchTools();
    } catch (e) {
      setToolsError(e instanceof Error ? e.message : "Failed to attach connector");
    } finally {
      setToolsAttaching(null);
    }
  }

  async function handleDetachConnector(connectorId: string) {
    setToolsAttaching(connectorId);
    setToolsError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/connectors/${connectorId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await fetchTools();
    } catch (e) {
      setToolsError(e instanceof Error ? e.message : "Failed to detach connector");
    } finally {
      setToolsAttaching(null);
    }
  }

  async function handleAddKnowledge() {
    if (knowledgeText.trim().length < 10) return;
    setKnowledgeSubmitting(true);
    setKnowledgeError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: knowledgeText,
          sourceName: knowledgeSourceName || "manual",
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(typeof b.error === "string" ? b.error : `HTTP ${res.status}`);
      }
      await res.json();
      setKnowledgeText("");
      setKnowledgeSourceName("");
      await fetchKnowledge();
      setKnowledgeError(null);
    } catch (e) {
      setKnowledgeError(e instanceof Error ? e.message : "Failed to ingest knowledge");
    } finally {
      setKnowledgeSubmitting(false);
    }
  }

  async function handleDeleteAllKnowledge() {
    if (!confirm("Delete all knowledge for this agent? This cannot be undone.")) return;
    setKnowledgeDeleting(true);
    setKnowledgeError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/knowledge`, { method: "DELETE" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(typeof b.error === "string" ? b.error : `HTTP ${res.status}`);
      }
      await fetchKnowledge();
    } catch (e) {
      setKnowledgeError(e instanceof Error ? e.message : "Failed to delete knowledge");
    } finally {
      setKnowledgeDeleting(false);
    }
  }

  useEffect(() => {
    fetchAgent();
  }, [fetchAgent]);

  useEffect(() => {
    if (activeTab === "usage") fetchUsage();
    if (activeTab === "skills") fetchSkills();
    if (activeTab === "knowledge") fetchKnowledge();
    if (activeTab === "mcp") fetchMcp();
    if (activeTab === "tools") fetchTools();
    if (activeTab === "memories") fetchMemories();
  }, [activeTab, fetchUsage, fetchSkills, fetchKnowledge, fetchMcp, fetchTools, fetchMemories]);

  async function handleStop() {
    if (!stopReason.trim()) return;
    setStopLoading(true);
    setStopError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: stopReason }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(
          (b as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`,
        );
      }
      setShowStopModal(false);
      setStopReason("");
      await fetchAgent();
    } catch (e) {
      setStopError(e instanceof Error ? e.message : "Failed to stop agent");
    } finally {
      setStopLoading(false);
    }
  }

  async function handleRunAgent() {
    if (!runInput.trim()) return;
    setRunLoading(true);
    setRunError(null);
    setRunResult(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: runInput }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { runId: string; status: string };
      setRunResult(data);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Failed to start agent run");
    } finally {
      setRunLoading(false);
    }
  }

  async function handleDeploy() {
    setActionLoading(true);
    setActionError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/deploy`, { method: "POST" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await fetchAgent();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Deploy failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUndeploy() {
    setActionLoading(true);
    setActionError(null);
    try {
      const res = await fetchWithTenant(`/api/agents/${agentId}/undeploy`, { method: "POST" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await fetchAgent();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Undeploy failed");
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-200 rounded-xl" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
        {error ?? "Agent not found"}
      </div>
    );
  }

  return (
    <div className={activeTab === "workspace" ? "max-w-[1400px] mx-auto" : "max-w-4xl mx-auto"}>
      <div className="mb-1">
        <a href="/agents" className="text-sm text-gray-400 hover:text-gray-600">
          &larr; Back to Agents
        </a>
      </div>

      <div className="flex items-center justify-between mb-6 mt-3">
        <h1 className="text-2xl font-bold text-gray-900">{agent.name}</h1>
        <div className="flex items-center gap-2">
          <AgentStatusBadge status={agent.status} />
          {agent.status === "tested" && (
            <button
              onClick={handleDeploy}
              disabled={actionLoading}
              className="inline-flex items-center px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
            >
              {actionLoading ? "Deploying..." : "Deploy"}
            </button>
          )}
          {agent.status === "deployed" && (
            <button
              onClick={handleUndeploy}
              disabled={actionLoading}
              className="inline-flex items-center px-3 py-1.5 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
            >
              {actionLoading ? "Undeploying..." : "Undeploy"}
            </button>
          )}
          {/* Stop button — visible when agent is active, degraded, or paused */}
          {(agent.status === "active" || agent.status === "degraded" || agent.status === "paused") && (
            <button
              onClick={() => setShowStopModal(true)}
              className="inline-flex items-center px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Stop Agent
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-4">
          {actionError}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 mb-4">
        {(["details", "run", "usage", "skills", "knowledge", "tools", "workspace", "memories", "mcp"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`pb-2 text-sm font-medium capitalize border-b-2 transition-colors ${
              activeTab === tab
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab === "mcp" ? "MCP" : tab === "tools" ? "Tools" : tab === "workspace" ? "Workspace" : tab === "memories" ? "Brain" : tab}
          </button>
        ))}
      </div>

      {activeTab === "run" && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Task / Prompt</p>
            <textarea
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
              rows={5}
              placeholder="Enter the task or prompt for this agent to execute..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-y"
            />
          </div>
          {runError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {runError}
            </div>
          )}
          {runResult && (
            <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm">
              <p className="font-medium text-green-800 mb-1">Run dispatched successfully</p>
              <p className="text-green-700">
                Run ID:{" "}
                <a
                  href={`/agents/${agentId}/runs/${runResult.runId}`}
                  className="font-mono underline hover:text-green-900"
                >
                  {runResult.runId}
                </a>
              </p>
              <p className="text-green-600 text-xs mt-1">Status: {runResult.status}</p>
            </div>
          )}
          <div className="flex justify-end">
            <button
              onClick={handleRunAgent}
              disabled={runLoading || !runInput.trim()}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
            >
              {runLoading ? "Dispatching..." : "Run Agent"}
            </button>
          </div>
        </div>
      )}

      {activeTab === "details" && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">Type</p>
              <p className="mt-0.5 font-medium text-gray-800">{agent.type}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">Version</p>
              <p className="mt-0.5 font-medium text-gray-800">
                {agent.version ?? <span className="text-gray-300">—</span>}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">Status</p>
              <div className="mt-1">
                <AgentStatusBadge status={agent.status} />
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">Created</p>
              <p className="mt-0.5 font-medium text-gray-800">
                {new Date(agent.createdAt).toLocaleString()}
              </p>
            </div>
          </div>

          {agent.description && (
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">Description</p>
              <p className="mt-0.5 text-sm text-gray-700">{agent.description}</p>
            </div>
          )}

          {/* Model Override Selector */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Model Configuration</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Preferred Model</label>
                <select
                  value={(agent.config?.preferred_model as string) ?? ""}
                  onChange={async (e) => {
                    const val = e.target.value;
                    try {
                      const res = await fetchWithTenant(`/api/agents/${agentId}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ config: { preferred_model: val || null } }),
                      });
                      if (res.ok) fetchAgent();
                    } catch {}
                  }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="">Default (claude-sonnet-4-6)</option>
                  <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (fast)</option>
                  <option value="anthropic.claude-sonnet-4-6-v1:0">Sonnet 4.6 (Bedrock)</option>
                  <option value="anthropic.claude-3-haiku-20240307-v1:0">Haiku 3 (Bedrock)</option>
                  <option value="claude-sonnet-4-6@20250514">Sonnet 4.6 (Vertex)</option>
                  <option value="claude-haiku-4-5@20251001">Haiku 4.5 (Vertex)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Routing Policy</label>
                <select
                  value={(agent.config?.routing_policy as string) ?? ""}
                  onChange={async (e) => {
                    const val = e.target.value;
                    try {
                      const res = await fetchWithTenant(`/api/agents/${agentId}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ config: { routing_policy: val || null } }),
                      });
                      if (res.ok) fetchAgent();
                    } catch {}
                  }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="">Balanced (default)</option>
                  <option value="cost_sensitive">Cost Sensitive</option>
                  <option value="accuracy_first">Accuracy First</option>
                  <option value="speed_optimized">Speed Optimized</option>
                </select>
              </div>
            </div>
            <div className="flex items-center gap-3 mt-3">
              <input
                type="checkbox"
                id="detail-rag-toggle"
                checked={(agent.config?.rag_enabled as boolean) ?? false}
                onChange={async (e) => {
                  try {
                    const res = await fetchWithTenant(`/api/agents/${agentId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ config: { rag_enabled: e.target.checked } }),
                    });
                    if (res.ok) fetchAgent();
                  } catch {}
                }}
                className="h-4 w-4 text-brand-600 rounded border-gray-300 focus:ring-brand-500"
              />
              <label htmlFor="detail-rag-toggle" className="text-sm text-gray-700">
                Enable RAG (Knowledge Retrieval)
              </label>
            </div>
            {(agent.config?.rag_enabled as boolean) && (
              <>
              <div className="mt-3">
                <label htmlFor="detail-rag-prompt" className="text-xs text-gray-400 uppercase tracking-wider">
                  RAG Grounding Prompt
                </label>
                <textarea
                  id="detail-rag-prompt"
                  rows={3}
                  defaultValue={(agent.config?.rag_prompt as string) ?? "Answer ONLY based on the knowledge provided below. Do not add information, policies, procedures, or details that are not explicitly stated in this context. If the answer is not covered by the provided knowledge, say you don't have that information. Never fabricate or assume details beyond what is written here."}
                  onBlur={async (e) => {
                    try {
                      const res = await fetchWithTenant(`/api/agents/${agentId}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ config: { rag_prompt: e.target.value } }),
                      });
                      if (res.ok) fetchAgent();
                    } catch {}
                  }}
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                />
                <p className="mt-1 text-xs text-gray-400">
                  Instructions prepended to retrieved knowledge. Controls how strictly the agent uses only its knowledge base.
                </p>
              </div>
              <div className="mt-3">
                <label htmlFor="detail-rag-timeout" className="text-xs text-gray-400 uppercase tracking-wider">
                  RAG Timeout (ms)
                </label>
                <input
                  id="detail-rag-timeout"
                  type="number"
                  min={100}
                  max={30000}
                  step={100}
                  placeholder="2000"
                  defaultValue={(agent.config?.rag_timeout_ms as number) ?? ""}
                  onBlur={async (e) => {
                    try {
                      const val = e.target.value ? parseInt(e.target.value, 10) : undefined;
                      const res = await fetchWithTenant(`/api/agents/${agentId}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ config: { rag_timeout_ms: val } }),
                      });
                      if (res.ok) fetchAgent();
                    } catch {}
                  }}
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                />
                <p className="mt-1 text-xs text-gray-400">
                  Max time to wait for RAG retrieval before starting model generation without context. Default: 2000ms.
                </p>
              </div>
              </>
            )}
          </div>

          {agent.deployedAt && (
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">Deployed At</p>
              <p className="mt-0.5 text-sm font-medium text-gray-800">
                {new Date(agent.deployedAt).toLocaleString()}
              </p>
            </div>
          )}

          {agent.lastHeartbeatAt && (
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">Last Heartbeat</p>
              <p className="mt-0.5 text-sm font-medium text-gray-800">
                {new Date(agent.lastHeartbeatAt).toLocaleString()}
              </p>
            </div>
          )}
        </div>
      )}

      {activeTab === "skills" && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          {skillsError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {skillsError}
            </div>
          )}

          {/* Add skill */}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Add Skill</p>
            <div className="flex gap-2">
              <select
                value={selectedSkillId}
                onChange={(e) => setSelectedSkillId(e.target.value)}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                disabled={skillActionLoading || skillsLoading}
              >
                <option value="">— select a skill —</option>
                {companySkills
                  .filter((s) => !assignedSkills.some((a) => a.id === s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <button
                onClick={handleAddSkill}
                disabled={!selectedSkillId || skillActionLoading}
                className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                Add
              </button>
            </div>
          </div>

          {/* Assigned skills list */}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Assigned Skills</p>
            {skillsLoading ? (
              <div className="py-4 text-center text-sm text-gray-400 animate-pulse">Loading…</div>
            ) : assignedSkills.length === 0 ? (
              <p className="text-sm text-gray-400">No skills assigned.</p>
            ) : (
              <ul className="space-y-2">
                {assignedSkills.map((skill) => (
                  <li
                    key={skill.id}
                    className="flex items-center justify-between rounded-lg border border-gray-100 px-4 py-2.5"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">{skill.name}</p>
                      {skill.description && (
                        <p className="text-xs text-gray-400 mt-0.5">{skill.description}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleRemoveSkill(skill.id)}
                      disabled={skillActionLoading}
                      className="ml-4 text-xs text-red-500 hover:text-red-700 disabled:opacity-50 transition-colors"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {activeTab === "usage" && (
        <div>
          {usageLoading ? (
            <div className="p-8 text-center text-gray-400 animate-pulse">Loading usage...</div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Cost to Date (this month)</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    ${(usageSummary?.costUsd ?? 0).toFixed(4)}
                  </p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Total Runs</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    {(usageSummary?.runCount ?? 0).toLocaleString()}
                  </p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Avg Cost per Run</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    ${usageSummary && usageSummary.runCount > 0
                      ? (usageSummary.costUsd / usageSummary.runCount).toFixed(4)
                      : "0.0000"}
                  </p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Avg Duration</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    {usageSummary && usageSummary.avgDurationMs > 0
                      ? `${(usageSummary.avgDurationMs / 1000).toFixed(1)}s`
                      : "—"}
                  </p>
                </div>
              </div>

              {/* Daily cost chart */}
              <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                <p className="text-sm font-semibold text-gray-700 mb-3">Daily Cost (this month)</p>
                {dailyData.length > 0 ? (
                  <>
                    <SparklineChart data={dailyData} />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>{dailyData[0]?.date}</span>
                      <span>{dailyData[dailyData.length - 1]?.date}</span>
                    </div>
                  </>
                ) : (
                  <div className="py-8 text-center text-sm text-gray-400">No runs this month</div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "knowledge" && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-5">
          {knowledgeError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {knowledgeError}
            </div>
          )}

          {/* Add knowledge */}
          <div className="space-y-3">
            <p className="text-xs text-gray-400 uppercase tracking-wider">Add Knowledge</p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Source Name</label>
              <input
                type="text"
                value={knowledgeSourceName}
                onChange={(e) => setKnowledgeSourceName(e.target.value)}
                placeholder="e.g. product-docs, FAQ, company-policy"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Text Content <span className="text-red-500">*</span>
              </label>
              <textarea
                value={knowledgeText}
                onChange={(e) => setKnowledgeText(e.target.value)}
                rows={6}
                placeholder="Paste knowledge text here (min 10 characters)..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-y"
              />
              <p className="text-xs text-gray-400 mt-1">
                Text will be chunked and embedded for retrieval-augmented generation (RAG).
              </p>
            </div>
            <div className="flex justify-end">
              <button
                onClick={handleAddKnowledge}
                disabled={knowledgeSubmitting || knowledgeText.trim().length < 10}
                className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                {knowledgeSubmitting ? "Ingesting..." : "Add Knowledge"}
              </button>
            </div>
          </div>

          {/* Knowledge chunks list */}
          <div className="space-y-3 border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400 uppercase tracking-wider">
                Stored Chunks ({knowledgeChunks.length})
              </p>
              {knowledgeChunks.length > 0 && (
                <button
                  onClick={handleDeleteAllKnowledge}
                  disabled={knowledgeDeleting}
                  className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50 transition-colors"
                >
                  {knowledgeDeleting ? "Deleting..." : "Delete All"}
                </button>
              )}
            </div>
            {knowledgeLoading ? (
              <div className="py-4 text-center text-sm text-gray-400 animate-pulse">Loading...</div>
            ) : knowledgeChunks.length === 0 ? (
              <p className="text-sm text-gray-400">No knowledge stored. Add text above to enable RAG.</p>
            ) : (
              <ul className="space-y-2 max-h-64 overflow-y-auto">
                {knowledgeChunks.map((chunk) => (
                  <li
                    key={chunk.id}
                    className="flex items-center justify-between rounded-lg border border-gray-100 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-700 truncate">
                        {(chunk.metadata?.source_name as string) || "manual"}
                      </p>
                      <p className="text-xs text-gray-400">
                        Chunk {((chunk.metadata?.chunk_index as number) ?? 0) + 1}
                        {chunk.metadata?.total_chunks ? ` of ${chunk.metadata.total_chunks}` : ""}
                        {" \u00b7 "}
                        {new Date(chunk.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {activeTab === "tools" && (
        <div className="space-y-6">
          {toolsError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {toolsError}
            </div>
          )}

          {toolsLoading ? (
            <div className="py-12 text-center text-sm text-gray-400 animate-pulse">Loading tool marketplace...</div>
          ) : toolsMarketplace.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
              <div className="text-4xl mb-3">🔧</div>
              <p className="text-sm font-medium text-gray-600 mb-1">No tools available yet</p>
              <p className="text-xs text-gray-400">
                Go to Admin → Connectors to create a REST API connector, then create tools on it.
              </p>
            </div>
          ) : (
            <>
              {/* Attached section */}
              {toolsMarketplace.some((c) => c.attached) && (
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <span className="w-2 h-2 bg-green-500 rounded-full" />
                    Installed on this agent
                  </p>
                  <div className="grid gap-4">
                    {toolsMarketplace.filter((c) => c.attached).map((connector) => (
                      <div key={connector.id} className="bg-white rounded-xl border-2 border-green-200 shadow-sm overflow-hidden">
                        <div className="px-5 py-4 flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-lg">
                                {connector.type === "rest_api" ? "🔌" : connector.type === "mcp_server" ? "🧩" : "⚙️"}
                              </span>
                              <h3 className="text-sm font-semibold text-gray-900">{connector.name}</h3>
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-green-100 text-green-700">
                                Active
                              </span>
                            </div>
                            {connector.description && (
                              <p className="text-xs text-gray-500 ml-7">{connector.description}</p>
                            )}
                          </div>
                          <button
                            onClick={() => handleDetachConnector(connector.id)}
                            disabled={toolsAttaching === connector.id}
                            className="px-3 py-1.5 text-xs font-medium text-red-600 hover:text-red-700 border border-red-200 hover:border-red-300 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {toolsAttaching === connector.id ? "Removing..." : "Remove"}
                          </button>
                        </div>
                        {connector.tools.length > 0 && (
                          <div className="border-t border-green-100 bg-green-50/30">
                            <div className="px-5 py-2">
                              <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-2">
                                {connector.tools.length} tool{connector.tools.length !== 1 ? "s" : ""} available to agent
                              </p>
                              <div className="space-y-2">
                                {connector.tools.map((tool) => (
                                  <div key={tool.id} className="flex items-start gap-2">
                                    <span className="text-green-500 mt-0.5 text-xs">●</span>
                                    <div>
                                      <p className="text-xs font-mono font-medium text-gray-700">{tool.name}</p>
                                      <p className="text-[11px] text-gray-500">{tool.description}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Available section */}
              {toolsMarketplace.some((c) => !c.attached) && (
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <span className="w-2 h-2 bg-gray-300 rounded-full" />
                    Available to install
                  </p>
                  <div className="grid gap-4">
                    {toolsMarketplace.filter((c) => !c.attached).map((connector) => (
                      <div key={connector.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden hover:border-brand-300 transition-colors">
                        <div className="px-5 py-4 flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-lg">
                                {connector.type === "rest_api" ? "🔌" : connector.type === "mcp_server" ? "🧩" : "⚙️"}
                              </span>
                              <h3 className="text-sm font-semibold text-gray-900">{connector.name}</h3>
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-gray-100 text-gray-500">
                                {connector.type.replace("_", " ")}
                              </span>
                            </div>
                            {connector.description && (
                              <p className="text-xs text-gray-500 ml-7">{connector.description}</p>
                            )}
                          </div>
                          <button
                            onClick={() => handleAttachConnector(connector.id)}
                            disabled={toolsAttaching === connector.id}
                            className="px-4 py-1.5 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {toolsAttaching === connector.id ? "Installing..." : "Install"}
                          </button>
                        </div>
                        {connector.tools.length > 0 && (
                          <div className="border-t border-gray-100 bg-gray-50/50">
                            <div className="px-5 py-2">
                              <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-2">
                                {connector.tools.length} tool{connector.tools.length !== 1 ? "s" : ""}
                              </p>
                              <div className="space-y-2">
                                {connector.tools.map((tool) => (
                                  <div key={tool.id} className="flex items-start gap-2">
                                    <span className="text-gray-300 mt-0.5 text-xs">○</span>
                                    <div>
                                      <p className="text-xs font-mono font-medium text-gray-600">{tool.name}</p>
                                      <p className="text-[11px] text-gray-400">{tool.description}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Map It! button */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <button
              onClick={() => { setMapItOpen(true); setMapItResult(null); setMapItError(null); setMapItSamplePayload(""); setMapItSampleResponse(""); setMapItDescription(""); setMapItApiDocs(""); }}
              className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white text-sm font-semibold rounded-lg shadow-sm transition-all flex items-center gap-2"
            >
              <span className="text-base">🗺️</span> Map It!
            </button>
            <p className="text-xs text-gray-400 mt-1.5">Paste any API payload and AI will generate the field mapping for a new tool</p>
          </div>
        </div>
      )}

      {/* Map It! Modal */}
      {mapItOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-purple-50 to-indigo-50 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <span>🗺️</span> Map It! — AI Field Mapper
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">Paste a sample API payload and describe what the tool does. AI maps the fields.</p>
              </div>
              <button onClick={() => setMapItOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {!mapItResult ? (
                /* Step 1: Input */
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">What does this tool do?</label>
                    <input
                      type="text"
                      value={mapItDescription}
                      onChange={(e) => setMapItDescription(e.target.value)}
                      placeholder="e.g. Create a taxi booking in iCabbi dispatch system"
                      className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      API Documentation <span className="text-gray-400 font-normal">(paste endpoint docs, field rules, constraints)</span>
                    </label>
                    <textarea
                      value={mapItApiDocs}
                      onChange={(e) => setMapItApiDocs(e.target.value)}
                      rows={6}
                      placeholder={"e.g. POST /bookings/update/{trip_id}\nUpdate a booking. Fields which cannot be updated will be ignored.\nA pre-booking may update: phone, date, driver_id, address, destination...\nA booking with a driver may only update: phone, name, instructions."}
                      className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Sample API Payload <span className="text-gray-400 font-normal">(paste the JSON the API expects)</span>
                    </label>
                    <textarea
                      value={mapItSamplePayload}
                      onChange={(e) => setMapItSamplePayload(e.target.value)}
                      rows={16}
                      placeholder={'{\n  "name": "John Smith",\n  "phone": "+353851234567",\n  "date": "2026-04-01T14:30:00.000Z",\n  "address": {\n    "lat": 53.3498,\n    "lng": -6.2603,\n    "formatted": "123 Main St"\n  }\n}'}
                      className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-gray-50"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Sample API Response <span className="text-gray-400 font-normal">(optional — paste what the API returns)</span>
                    </label>
                    <textarea
                      value={mapItSampleResponse}
                      onChange={(e) => setMapItSampleResponse(e.target.value)}
                      rows={8}
                      placeholder={'{\n  "version": 2,\n  "code": 200,\n  "body": {\n    "trip_id": 12345,\n    "status": "NEW",\n    "driver": { "name": "Mike", "vehicle_ref": "X999" }\n  }\n}'}
                      className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-gray-50"
                    />
                  </div>
                  {mapItError && (
                    <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2.5 text-sm text-red-700">{mapItError}</div>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={handleMapIt}
                      disabled={mapItLoading || !mapItSamplePayload.trim()}
                      className="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition-all"
                    >
                      {mapItLoading ? "AI is mapping..." : "Generate Mapping"}
                    </button>
                  </div>
                </div>
              ) : (
                /* Step 2: Results — visual mapping */
                <div className="space-y-6">
                  {/* Mapping visualization */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                      Field Mapping
                      <span className="text-xs font-normal text-gray-400">({Object.keys(mapItEditingMapping).length} fields mapped)</span>
                    </h3>
                    <div className="border border-gray-200 rounded-xl overflow-hidden">
                      {/* Header row */}
                      <div className="grid grid-cols-12 gap-0 bg-gray-50 border-b border-gray-200 text-[10px] font-bold uppercase tracking-wider text-gray-500 px-4 py-2">
                        <div className="col-span-4">Agent Collects</div>
                        <div className="col-span-1 text-center">Confidence</div>
                        <div className="col-span-1 text-center"></div>
                        <div className="col-span-4">API Receives</div>
                        <div className="col-span-2 text-center">Type</div>
                      </div>
                      {/* Mapping rows */}
                      {(mapItResult.confidence ?? []).map((c, idx) => {
                        const schema = mapItResult.inputSchema as { properties?: Record<string, { description?: string; type?: string }> };
                        const prop = schema?.properties?.[c.input];
                        const scoreColor = c.score >= 0.9 ? "bg-green-500" : c.score >= 0.7 ? "bg-yellow-500" : "bg-red-500";
                        const scoreLabel = c.score >= 0.9 ? "High" : c.score >= 0.7 ? "Med" : "Low";
                        return (
                          <div key={idx} className={`grid grid-cols-12 gap-0 px-4 py-2.5 items-center ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"} hover:bg-purple-50/30 transition-colors`}>
                            {/* Left: agent field */}
                            <div className="col-span-4">
                              <p className="text-sm font-mono font-medium text-gray-800">{c.input}</p>
                              {prop?.description && <p className="text-[11px] text-gray-400 mt-0.5 leading-tight">{prop.description}</p>}
                            </div>
                            {/* Confidence */}
                            <div className="col-span-1 flex justify-center">
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold text-white ${scoreColor}`}>
                                {scoreLabel}
                              </span>
                            </div>
                            {/* Arrow */}
                            <div className="col-span-1 text-center text-gray-300 text-lg">→</div>
                            {/* Right: API field (editable) */}
                            <div className="col-span-4">
                              <input
                                type="text"
                                value={mapItEditingMapping[c.input] ?? c.api}
                                onChange={(e) => setMapItEditingMapping((m) => ({ ...m, [c.input]: e.target.value }))}
                                className="w-full text-sm font-mono border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-purple-500 focus:border-purple-500"
                              />
                              <p className="text-[10px] text-gray-400 mt-0.5">{c.reason}</p>
                            </div>
                            {/* Type */}
                            <div className="col-span-2 text-center">
                              <span className="text-[10px] font-mono text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{prop?.type ?? "string"}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* API fields reference */}
                  <details className="group">
                    <summary className="text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform">▶</span>
                      All API Fields ({mapItResult.apiFields.length})
                    </summary>
                    <div className="mt-2 bg-gray-50 rounded-lg border border-gray-200 p-3 max-h-48 overflow-y-auto">
                      <div className="grid grid-cols-3 gap-1 text-[11px] font-mono">
                        {mapItResult.apiFields.map((f, i) => (
                          <div key={i} className="text-gray-600">
                            <span className="text-gray-400">{f.type}</span> {f.path}
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>

                  {/* Generated schema preview */}
                  <details className="group">
                    <summary className="text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform">▶</span>
                      Generated Input Schema (JSON)
                    </summary>
                    <pre className="mt-2 bg-gray-900 text-green-400 rounded-lg p-4 text-xs overflow-x-auto max-h-64">
                      {JSON.stringify(mapItResult.inputSchema, null, 2)}
                    </pre>
                  </details>

                  {/* Response Mapping */}
                  {mapItResult.responseFields && mapItResult.responseFields.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                        Response Mapping
                        <span className="text-xs font-normal text-gray-400">({mapItResult.responseFields.length} fields)</span>
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-100 text-blue-700">← FROM API</span>
                      </h3>
                      <div className="border border-blue-200 rounded-xl overflow-hidden">
                        <div className="grid grid-cols-12 gap-0 bg-blue-50 border-b border-blue-200 text-[10px] font-bold uppercase tracking-wider text-blue-600 px-4 py-2">
                          <div className="col-span-4">API Returns</div>
                          <div className="col-span-1 text-center"></div>
                          <div className="col-span-3">Agent Sees</div>
                          <div className="col-span-4">Description</div>
                        </div>
                        {mapItResult.responseFields.map((rf, idx) => (
                          <div key={idx} className={`grid grid-cols-12 gap-0 px-4 py-2.5 items-center ${idx % 2 === 0 ? "bg-white" : "bg-blue-50/30"}`}>
                            <div className="col-span-4">
                              <code className="text-xs font-mono text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">{rf.apiField}</code>
                            </div>
                            <div className="col-span-1 text-center text-blue-400">→</div>
                            <div className="col-span-3">
                              <code className="text-xs font-mono text-gray-700 bg-gray-100 px-1.5 py-0.5 rounded">{rf.friendlyName}</code>
                            </div>
                            <div className="col-span-4">
                              <span className="text-xs text-gray-500">{rf.description}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Save as Tool */}
                  <div className="border-t border-gray-200 pt-4 space-y-3">
                    <h3 className="text-sm font-semibold text-gray-700">Save as Tool</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Tool Name</label>
                        <input
                          type="text"
                          value={mapItToolName}
                          onChange={(e) => setMapItToolName(e.target.value)}
                          placeholder="e.g. Update Booking"
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Connector</label>
                        <select
                          value={mapItConnectorId}
                          onChange={(e) => setMapItConnectorId(e.target.value)}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white"
                        >
                          <option value="">Select connector...</option>
                          {toolsMarketplace.map((c) => (
                            <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Endpoint Path</label>
                        <input
                          type="text"
                          value={mapItEndpointPath}
                          onChange={(e) => setMapItEndpointPath(e.target.value)}
                          placeholder="e.g. bookings/update/{trip_id}"
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">HTTP Method</label>
                        <select
                          value={mapItHttpMethod}
                          onChange={(e) => setMapItHttpMethod(e.target.value)}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white"
                        >
                          <option value="POST">POST</option>
                          <option value="GET">GET</option>
                          <option value="PUT">PUT</option>
                          <option value="PATCH">PATCH</option>
                          <option value="DELETE">DELETE</option>
                        </select>
                      </div>
                    </div>
                    {mapItError && (
                      <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{mapItError}</div>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <button
                      onClick={() => setMapItResult(null)}
                      className="text-sm text-gray-500 hover:text-gray-700"
                    >
                      ← Re-map
                    </button>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(JSON.stringify({
                            input_schema: mapItResult.inputSchema,
                            field_mapping: mapItEditingMapping,
                            response_mapping: mapItResult.responseMapping ?? {},
                          }, null, 2));
                        }}
                        className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        Copy JSON
                      </button>
                      <button
                        onClick={handleSaveAsTool}
                        disabled={mapItSaving || !mapItToolName.trim() || !mapItEndpointPath.trim() || !mapItConnectorId}
                        className="px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition-all"
                      >
                        {mapItSaving ? "Saving..." : "Save as Tool"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "workspace" && (
        <WorkspaceTab agentId={agentId} />
      )}

      {activeTab === "memories" && (
        <div className="space-y-6">
          {/* Header */}
          <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-xl border border-amber-200 shadow-sm p-5">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">🧠</span>
              <div>
                <h3 className="text-sm font-bold text-gray-900">Shared Agent Brain</h3>
                <p className="text-xs text-gray-500">
                  Agents automatically save learnings here when they resolve errors, discover API quirks, or find better approaches.
                  Every agent in your organization reads from this brain before each run.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4 mt-3">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className="inline-block w-2 h-2 rounded-full bg-green-400"></span>
                {memories.length} memories shared
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-400"></span>
                {memories.filter(m => m.source === "agent_auto").length} from AI agents
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className="inline-block w-2 h-2 rounded-full bg-blue-400"></span>
                {memories.reduce((sum, m) => sum + m.upvotes, 0)} total upvotes
              </div>
            </div>
          </div>

          {memoriesError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{memoriesError}</div>
          )}

          {/* Memory list */}
          {memoriesLoading ? (
            <div className="py-8 text-center text-sm text-gray-400 animate-pulse">Loading shared brain...</div>
          ) : memories.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
              <div className="text-4xl mb-3">🧠</div>
              <p className="text-sm font-medium text-gray-600 mb-1">No memories yet</p>
              <p className="text-xs text-gray-400 max-w-md mx-auto">
                Agents will automatically save learnings here as they work. When an agent resolves an error,
                discovers an API quirk, or finds a better approach, it saves the insight for all other agents to learn from.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {memories.map((m) => {
                const categoryColors: Record<string, string> = {
                  learning: "bg-blue-100 text-blue-700",
                  error_fix: "bg-red-100 text-red-700",
                  tool_tip: "bg-green-100 text-green-700",
                  prompt_pattern: "bg-purple-100 text-purple-700",
                  api_quirk: "bg-orange-100 text-orange-700",
                  general: "bg-gray-100 text-gray-600",
                };
                return (
                  <div key={m.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-gray-900">{m.title}</h3>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase ${categoryColors[m.category] ?? categoryColors.general}`}>
                          {m.category.replace("_", " ")}
                        </span>
                        {m.source === "agent_auto" && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-amber-50 text-amber-600 border border-amber-200">
                            AI learned
                          </span>
                        )}
                        {m.agent_name && (
                          <span className="text-[10px] text-gray-400">from {m.agent_name}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleUpvoteMemory(m.id)}
                          className="p-1 text-gray-400 hover:text-amber-500 transition-colors"
                          title="Mark as helpful — higher upvoted memories are prioritized"
                        >
                          <span className="text-sm">👍</span>
                        </button>
                        <span className="text-xs text-gray-400 min-w-[20px] text-center">{m.upvotes}</span>
                        <button
                          onClick={() => handleDeleteMemory(m.id)}
                          className="p-1 text-gray-300 hover:text-red-500 transition-colors ml-1"
                          title="Delete — remove if unhelpful or wrong"
                        >
                          <span className="text-xs">✕</span>
                        </button>
                      </div>
                    </div>
                    <p className="text-sm text-gray-600 whitespace-pre-wrap">{m.content}</p>
                    {Array.isArray(m.tags) && m.tags.length > 0 && (
                      <div className="flex gap-1 mt-2">
                        {m.tags.map((tag, i) => (
                          <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-500">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-2 text-[10px] text-gray-300">
                      <span>{new Date(m.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === "mcp" && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          {mcpError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {mcpError}
            </div>
          )}

          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-3">MCP Server Connectors</p>
            {mcpLoading ? (
              <div className="py-4 text-center text-sm text-gray-400 animate-pulse">Loading MCP connectors...</div>
            ) : mcpConnectors.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-gray-400 mb-2">No MCP server connectors attached.</p>
                <p className="text-xs text-gray-400">
                  Create an MCP server connector in the admin connectors page, then attach it to this agent.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {mcpConnectors.map((connector) => {
                  const tools = connector.config?.tools ?? [];
                  return (
                    <div
                      key={connector.id}
                      className="rounded-lg border border-gray-200 overflow-hidden"
                    >
                      <div className="bg-gray-50 px-4 py-3 flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold text-gray-800">{connector.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {connector.config?.transport ?? "http"} transport
                            {connector.config?.endpoint ? ` \u00b7 ${connector.config.endpoint}` : ""}
                          </p>
                        </div>
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-700">
                          {tools.length} tool{tools.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      {tools.length > 0 && (
                        <div className="divide-y divide-gray-100">
                          {tools.map((tool, idx) => (
                            <div key={idx} className="px-4 py-3">
                              <p className="text-sm font-medium text-gray-700 font-mono">{tool.name}</p>
                              {tool.description && (
                                <p className="text-xs text-gray-500 mt-0.5">{tool.description}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stop Agent Confirmation Modal */}
      {showStopModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Stop Agent</h2>
            <p className="text-sm text-gray-600 mb-4">
              This will stop the agent and cancel any running tasks. Please provide a reason.
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reason <span className="text-red-500">*</span>
              </label>
              <textarea
                value={stopReason}
                onChange={(e) => setStopReason(e.target.value)}
                rows={3}
                placeholder="e.g. Maintenance required, unexpected behavior detected..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
              />
            </div>
            {stopError && (
              <div className="mt-2 rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                {stopError}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowStopModal(false);
                  setStopReason("");
                  setStopError(null);
                }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                onClick={handleStop}
                disabled={stopLoading || !stopReason.trim()}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                {stopLoading ? "Stopping..." : "Stop Agent"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
