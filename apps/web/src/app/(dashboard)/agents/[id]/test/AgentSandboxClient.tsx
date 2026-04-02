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

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface LogEntry {
  ts: string;
  stage: string;
  message: string;
  detail?: Record<string, unknown>;
  level: "info" | "warn" | "error";
  durationMs?: number;
}

type RunStatus = "idle" | "queued" | "running" | "done" | "error";

const STAGE_ICONS: Record<string, string> = {
  init: "▶",
  model: "⚙",
  rag: "📚",
  provider: "☁",
  mcp: "🔧",
  llm: "🤖",
  done: "✓",
  error: "✗",
};

const LEVEL_COLORS: Record<string, string> = {
  info: "text-gray-600",
  warn: "text-amber-600",
  error: "text-red-600",
};

export function AgentSandboxClient({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [stats, setStats] = useState<RunStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamBufferRef = useRef("");

  // Auto-scroll thread to bottom
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages, streamingContent]);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup SSE and polling on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || status === "queued" || status === "running") return;

    const userMessage = prompt.trim();
    setPrompt("");
    setError(null);
    setStats(null);
    setStreamingContent("");
    streamBufferRef.current = "";
    setStatus("queued");
    setLogs([]);

    // Append user message to thread
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);

    // Close any existing SSE
    eventSourceRef.current?.close();

    try {
      // Start a run via the execution engine
      const res = await fetch(`/api/agents/${agentId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: userMessage, stream: false }),
      });

      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const run = await res.json();
      const newRunId = run.id ?? run.runId;
      setRunId(newRunId);
      setStatus("running");

      // Connect to SSE stream for this run
      const sseUrl = `/api/agent-runs/${newRunId}/stream`;
      const es = new EventSource(sseUrl);
      eventSourceRef.current = es;
      let committed = false;

      function commitStream() {
        if (committed) return;
        committed = true;
        const finalContent = streamBufferRef.current;
        streamBufferRef.current = "";
        setStreamingContent("");
        if (finalContent) {
          setMessages((prev) => [...prev, { role: "assistant", content: finalContent }]);
        }
      }

      es.onmessage = (event) => {
        if (event.data === "[DONE]") {
          commitStream();
          setStatus("done");
          es.close();
          return;
        }

        try {
          const data = JSON.parse(event.data);

          if (data.runId && !newRunId) {
            setRunId(data.runId);
          }

          // Structured log event from worker
          if (data.log) {
            setLogs((prev) => [...prev, data.log as LogEntry]);
            return;
          }

          // RAG status events (legacy — also captured via log)
          if (data.ragStatus) return;

          if (data.chunk) {
            streamBufferRef.current += data.chunk;
            setStreamingContent(streamBufferRef.current);
          }

          if (data.status === "completed" || data.status === "done") {
            commitStream();
            setStatus("done");
            setStats({
              tokensInput: data.tokens_input ?? 0,
              tokensOutput: data.tokens_output ?? 0,
              costUsd: data.cost_usd ?? 0,
              durationMs: data.duration_ms ?? 0,
              status: "completed",
            });
            // Load persisted logs from run record
            if (data.logs && Array.isArray(data.logs)) {
              setLogs(data.logs);
            }
            es.close();
          }

          if (data.status === "failed" || data.status === "error") {
            commitStream();
            setStatus("error");
            setError(data.error ?? "Run failed");
            es.close();
          }
        } catch {
          // Non-JSON chunk — treat as raw text
          streamBufferRef.current += event.data;
          setStreamingContent(streamBufferRef.current);
        }
      };

      es.onerror = () => {
        es.close();
        if (!committed) {
          // SSE failed silently — polling will handle completion
        }
      };

      // Polling fallback
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        if (committed) {
          if (pollRef.current) clearInterval(pollRef.current);
          return;
        }
        try {
          const pollRes = await fetch(`/api/agent-runs/${newRunId}`);
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();
          if (pollData.status === "completed" && pollData.output) {
            if (pollRef.current) clearInterval(pollRef.current);
            es.close();
            if (!committed) {
              committed = true;
              streamBufferRef.current = "";
              setStreamingContent("");
              const outputText = typeof pollData.output === "string"
                ? pollData.output
                : typeof pollData.output?.text === "string"
                  ? pollData.output.text
                  : JSON.stringify(pollData.output);
              setMessages((prev) => [...prev, { role: "assistant", content: outputText }]);
              setStatus("done");
              setStats({
                tokensInput: pollData.tokensInput ?? pollData.tokens_input ?? 0,
                tokensOutput: pollData.tokensOutput ?? pollData.tokens_output ?? 0,
                costUsd: Number(pollData.costUsd ?? pollData.cost_usd ?? 0),
                durationMs: pollData.durationMs ?? pollData.duration_ms ?? 0,
                status: "completed",
              });
              // Load persisted logs
              if (pollData.logs && Array.isArray(pollData.logs)) {
                setLogs(pollData.logs);
              }
            }
          } else if (pollData.status === "failed") {
            if (pollRef.current) clearInterval(pollRef.current);
            es.close();
            if (!committed) {
              committed = true;
              streamBufferRef.current = "";
              setStreamingContent("");
              setStatus("error");
              setError(pollData.error ?? "Run failed");
              if (pollData.logs && Array.isArray(pollData.logs)) {
                setLogs(pollData.logs);
              }
            }
          }
        } catch {
          // Polling error — silently retry next interval
        }
      }, 3000);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Failed to start run");
    }
  }

  function handleApproveForDeployment() {
    router.push(`/agents/${agentId}?deploy=true`);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleRun(e as unknown as React.FormEvent);
    }
  }

  function formatTime(ts: string) {
    try {
      return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return "";
    }
  }

  const isRunning = status === "queued" || status === "running";

  return (
    <div className="flex flex-col h-full" style={{ minHeight: "600px" }}>
      <div className="flex items-center gap-3 mb-1">
        <a href="/agents" className="text-sm text-gray-400 hover:text-gray-600">&larr; Agents</a>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Agent Sandbox</h1>

      {/* Chat thread */}
      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-col" style={{ minHeight: "400px" }}>
        <div
          ref={threadRef}
          className="flex-1 overflow-y-auto space-y-3 mb-4"
          style={{ minHeight: "300px", maxHeight: "500px" }}
        >
          {messages.length === 0 && !streamingContent && (
            <p className="text-sm text-gray-300 text-center mt-8">
              Send a message to test this agent&hellip;
            </p>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-brand-600 text-white rounded-br-sm"
                    : "bg-gray-100 text-gray-900 rounded-bl-sm"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {/* Streaming assistant bubble */}
          {streamingContent && (
            <div className="flex justify-start">
              <div className="max-w-[75%] rounded-2xl rounded-bl-sm px-4 py-2 text-sm whitespace-pre-wrap bg-gray-100 text-gray-900">
                {streamingContent}
                <span className="inline-block w-1.5 h-3.5 bg-gray-400 animate-pulse ml-0.5 align-middle" />
              </div>
            </div>
          )}

          {/* Running indicator when no output yet */}
          {isRunning && !streamingContent && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-bl-sm px-4 py-2 bg-gray-100 text-gray-400 text-sm">
                <span className="animate-pulse">thinking...</span>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {/* Input area */}
        <form onSubmit={handleRun} className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Enter a prompt... (Enter to send, Shift+Enter for newline)"
            disabled={isRunning}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isRunning || !prompt.trim()}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors self-end"
          >
            {isRunning ? "..." : "Send"}
          </button>
        </form>
      </div>

      {/* Stats footer */}
      {stats && (
        <div className="mt-4 bg-white rounded-xl border border-gray-200 shadow-sm p-4">
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
                {stats.durationMs > 0 ? `${(stats.durationMs / 1000).toFixed(1)}s` : "--"}
              </p>
            </div>
          </div>

          {status === "done" && stats.status !== "failed" && (
            <button
              onClick={handleApproveForDeployment}
              className="mt-3 w-full px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Approve for Deployment
            </button>
          )}
        </div>
      )}

      {/* Run Log panel */}
      {(logs.length > 0 || isRunning) && (
        <div className="mt-4 bg-gray-900 rounded-xl border border-gray-700 shadow-sm overflow-hidden">
          <button
            onClick={() => setLogsOpen(!logsOpen)}
            className="w-full flex items-center justify-between px-4 py-2 text-xs font-mono text-gray-300 hover:bg-gray-800 transition-colors"
          >
            <span>Run Log {logs.length > 0 && `(${logs.length} events)`}</span>
            <span>{logsOpen ? "Hide" : "Show"}</span>
          </button>

          {logsOpen && (
            <div
              ref={logRef}
              className="overflow-y-auto font-mono text-xs leading-5 px-4 pb-3"
              style={{ maxHeight: "300px" }}
            >
              {logs.map((entry, i) => (
                <div key={i} className={`flex gap-2 ${LEVEL_COLORS[entry.level] ?? "text-gray-400"}`}>
                  <span className="text-gray-500 shrink-0">{formatTime(entry.ts)}</span>
                  <span className="shrink-0 w-4 text-center">{STAGE_ICONS[entry.stage] ?? "·"}</span>
                  <span className="shrink-0 text-gray-500 w-16">[{entry.stage}]</span>
                  <span className="flex-1">
                    {entry.message}
                    {entry.durationMs !== undefined && (
                      <span className="text-gray-500 ml-1">({entry.durationMs}ms)</span>
                    )}
                  </span>
                </div>
              ))}
              {isRunning && logs.length > 0 && (
                <div className="text-gray-500 animate-pulse mt-1">waiting...</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Run ID debug footer */}
      {runId && (
        <p className="mt-2 text-xs text-gray-300 text-right">Run: {runId}</p>
      )}
    </div>
  );
}
