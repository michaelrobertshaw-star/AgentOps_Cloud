"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";

interface AgentRun {
  id: string;
  agentId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "timed_out" | string;
  input: Record<string, unknown> | null;
  output: string | null;
  error: string | null;
  model: string | null;
  tokensInput: number;
  tokensOutput: number;
  costUsd: string | null;
  durationMs: number | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);
const POLL_INTERVAL_MS = 2000;

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; class: string; spinner?: boolean }> = {
    queued: { label: "Queued", class: "bg-gray-100 text-gray-600" },
    running: { label: "Running", class: "bg-blue-100 text-blue-700", spinner: true },
    completed: { label: "Completed", class: "bg-green-100 text-green-700" },
    failed: { label: "Failed", class: "bg-red-100 text-red-700" },
    cancelled: { label: "Cancelled", class: "bg-orange-100 text-orange-700" },
    timed_out: { label: "Timed Out", class: "bg-red-100 text-red-600" },
  };
  const cfg = map[status] ?? { label: status, class: "bg-gray-100 text-gray-600" };

  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold ${cfg.class}`}>
      {cfg.spinner && (
        <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
      )}
      {cfg.label}
    </span>
  );
}

export default function AgentRunDetailPage() {
  const params = useParams<{ id: string; runId: string }>();
  const agentId = params.id;
  const runId = params.runId;

  const [run, setRun] = useState<AgentRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRun = useCallback(async () => {
    try {
      const res = await fetch(`/api/agent-runs/${runId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AgentRun;
      setRun(data);
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load run");
      return null;
    } finally {
      setLoading(false);
    }
  }, [runId]);

  // Initial fetch + polling while in non-terminal state
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    fetchRun().then((initialRun) => {
      if (initialRun && !TERMINAL_STATUSES.has(initialRun.status)) {
        interval = setInterval(async () => {
          const updated = await fetchRun();
          if (updated && TERMINAL_STATUSES.has(updated.status)) {
            if (interval) {
              clearInterval(interval);
              interval = null;
            }
          }
        }, POLL_INTERVAL_MS);
      }
    });

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [fetchRun]);

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4 animate-pulse">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-200 rounded-xl" />
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error ?? "Run not found"}
        </div>
      </div>
    );
  }

  const inputText =
    typeof run.input === "object" && run.input !== null && "text" in run.input
      ? String(run.input.text)
      : JSON.stringify(run.input ?? {}, null, 2);

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-1">
        <a
          href={`/agents/${agentId}`}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          &larr; Back to Agent
        </a>
      </div>

      <div className="flex items-center justify-between mb-6 mt-3">
        <h1 className="text-2xl font-bold text-gray-900">Run Detail</h1>
        <StatusBadge status={run.status} />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-5">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Run ID</p>
            <p className="mt-0.5 font-mono text-xs text-gray-600 break-all">{run.id}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Model</p>
            <p className="mt-0.5 font-medium text-gray-800">{run.model ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Started</p>
            <p className="mt-0.5 font-medium text-gray-800">
              {new Date(run.startedAt).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Duration</p>
            <p className="mt-0.5 font-medium text-gray-800">
              {run.durationMs != null ? `${(run.durationMs / 1000).toFixed(2)}s` : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Tokens In / Out</p>
            <p className="mt-0.5 font-medium text-gray-800">
              {run.tokensInput.toLocaleString()} / {run.tokensOutput.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Cost</p>
            <p className="mt-0.5 font-medium text-gray-800">
              {run.costUsd ? `$${parseFloat(run.costUsd).toFixed(6)}` : "—"}
            </p>
          </div>
        </div>

        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Input</p>
          <pre className="text-xs bg-gray-50 border border-gray-100 rounded-lg p-3 whitespace-pre-wrap break-words text-gray-700 max-h-40 overflow-y-auto">
            {inputText}
          </pre>
        </div>

        {run.status === "running" && (
          <div className="flex items-center gap-2 text-sm text-blue-600">
            <span className="inline-block w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            Agent is processing... polling every {POLL_INTERVAL_MS / 1000}s
          </div>
        )}

        {run.output && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Output</p>
            <pre className="text-xs bg-gray-50 border border-gray-100 rounded-lg p-3 whitespace-pre-wrap break-words text-gray-700 max-h-96 overflow-y-auto">
              {run.output}
            </pre>
          </div>
        )}

        {run.error && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Error</p>
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {run.error}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
