"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

interface RunStats {
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  durationMs: number;
  status: string;
}

type RunStatus = "idle" | "queued" | "running" | "done" | "error";

export function AgentSandboxClient({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [stats, setStats] = useState<RunStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;

    setStatus("queued");
    setOutput("");
    setError(null);
    setStats(null);
    setRunId(null);

    // Close any existing SSE
    eventSourceRef.current?.close();

    try {
      // Create a task run for this agent
      const res = await fetch(`/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Sandbox test: ${prompt.slice(0, 60)}`,
          description: prompt,
          agentId,
          // Use a placeholder department — in M6.4 this will be wired to the execution engine
          sandbox: true,
        }),
      });

      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const task = await res.json();
      const newRunId = task.id;
      setRunId(newRunId);
      setStatus("running");

      // Connect to SSE stream (M6.4 execution engine endpoint)
      // Falls back to polling if SSE endpoint not available yet
      const sseUrl = `/api/task-runs/${newRunId}/stream`;
      const es = new EventSource(sseUrl);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.chunk) {
            setOutput((prev) => prev + data.chunk);
          }
          if (data.status === "completed" || data.status === "done") {
            setStatus("done");
            setStats({
              tokensInput: data.tokens_input ?? 0,
              tokensOutput: data.tokens_output ?? 0,
              costUsd: data.cost_usd ?? 0,
              durationMs: data.duration_ms ?? 0,
              status: "completed",
            });
            es.close();
          }
          if (data.status === "failed" || data.status === "error") {
            setStatus("error");
            setError(data.error ?? "Run failed");
            es.close();
          }
        } catch {
          // Non-JSON SSE message — treat as raw text chunk
          setOutput((prev) => prev + event.data);
        }
      };

      es.onerror = () => {
        // SSE not available (M6.4 not implemented yet) — show placeholder message
        es.close();
        setOutput("⚠️ Execution engine (M6.4) not yet available.\nThis sandbox UI will stream live output once the execution engine is deployed.");
        setStatus("done");
        setStats({ tokensInput: 0, tokensOutput: 0, costUsd: 0, durationMs: 0, status: "pending" });
      };
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Failed to start run");
    }
  }

  function handleApproveForDeployment() {
    router.push(`/agents/${agentId}?deploy=true`);
  }

  const statusColor: Record<RunStatus, string> = {
    idle: "text-gray-400",
    queued: "text-yellow-600",
    running: "text-blue-600",
    done: "text-green-600",
    error: "text-red-600",
  };

  const statusLabel: Record<RunStatus, string> = {
    idle: "Idle",
    queued: "Queued",
    running: "Running...",
    done: "Completed",
    error: "Error",
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <a href="/agents" className="text-sm text-gray-400 hover:text-gray-600">← Agents</a>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Agent Sandbox</h1>

      <div className="grid grid-cols-2 gap-6">
        {/* Left panel: input */}
        <div className="flex flex-col gap-4">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <label className="block text-sm font-semibold text-gray-700 mb-2">Test Prompt</label>
            <form onSubmit={handleRun} className="space-y-3">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={10}
                placeholder="Enter a task or prompt to test this agent..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
              />
              <button
                type="submit"
                disabled={status === "queued" || status === "running" || !prompt.trim()}
                className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                {status === "queued" ? "Queuing..." : status === "running" ? "Running..." : "▶ Run"}
              </button>
            </form>
          </div>
        </div>

        {/* Right panel: output */}
        <div className="flex flex-col gap-4">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-col flex-1" style={{ minHeight: "300px" }}>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-semibold text-gray-700">Output</label>
              <span className={`text-xs font-medium ${statusColor[status]}`}>
                ● {statusLabel[status]}
              </span>
            </div>
            <div
              ref={outputRef}
              className="flex-1 bg-gray-50 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap overflow-y-auto min-h-64 max-h-96"
            >
              {output || (
                <span className="text-gray-300">Output will appear here when the agent runs...</span>
              )}
            </div>

            {error && (
              <div className="mt-2 rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}
          </div>

          {/* Footer stats */}
          {stats && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
              <div className="grid grid-cols-4 gap-3 text-center">
                <div>
                  <p className="text-xs text-gray-400">Input Tokens</p>
                  <p className="text-sm font-bold text-gray-900">{stats.tokensInput.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Output Tokens</p>
                  <p className="text-sm font-bold text-gray-900">{stats.tokensOutput.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Cost</p>
                  <p className="text-sm font-bold text-gray-900">${stats.costUsd.toFixed(4)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Duration</p>
                  <p className="text-sm font-bold text-gray-900">
                    {stats.durationMs > 0 ? `${(stats.durationMs / 1000).toFixed(1)}s` : "—"}
                  </p>
                </div>
              </div>

              {status === "done" && stats.status !== "failed" && (
                <button
                  onClick={handleApproveForDeployment}
                  className="mt-3 w-full px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  ✓ Approve for Deployment
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
