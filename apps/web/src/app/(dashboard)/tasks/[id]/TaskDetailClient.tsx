"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  departmentId: string;
  agentId: string | null;
  parentTaskId: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  retryCount: number;
  maxRetries: number;
  timeoutSeconds: number;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  task: Task;
  department: { id: string; name: string } | null;
  agent: { id: string; name: string } | null;
}

const STATUS_STEPS = ["pending", "queued", "running", "completed"] as const;
const TERMINAL_FAILED = ["failed", "cancelled"] as const;

export function TaskDetailClient({ task: initialTask, department, agent }: Props) {
  const [task, setTask] = useState(initialTask);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [outputPage, setOutputPage] = useState(0);
  const router = useRouter();

  const runAction = useCallback(
    async (endpoint: string, body?: Record<string, unknown>) => {
      setLoading(true);
      setActionError(null);
      try {
        const res = await fetch(endpoint, {
          method: body !== undefined ? "POST" : "POST",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const updated = (await res.json()) as Task;
        setTask(updated);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Action failed");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const canRetry = task.status === "failed" && task.retryCount < task.maxRetries;
  const canCancel = ["pending", "queued", "running"].includes(task.status);
  const isFailed = (TERMINAL_FAILED as readonly string[]).includes(task.status);

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Link href="/tasks" className="hover:text-gray-900">Tasks</Link>
            <span>/</span>
            <span className="truncate max-w-xs">{task.id.slice(0, 8)}&hellip;</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900 leading-tight">{task.title}</h1>
          {task.description && (
            <p className="text-sm text-gray-500 mt-1">{task.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
        </div>
      </div>

      {/* Action error */}
      {actionError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {/* Actions */}
      {(canRetry || canCancel) && (
        <div className="flex gap-2">
          {canRetry && (
            <button
              onClick={() => runAction(`/api/tasks/${task.id}/retry`)}
              disabled={loading}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              Retry
            </button>
          )}
          {canCancel && (
            <button
              onClick={() => runAction(`/api/tasks/${task.id}/cancel`)}
              disabled={loading}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Metadata + links */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <MetaField label="Department">
          {department ? (
            <Link
              href={`/departments/${department.id}`}
              className="text-brand-600 hover:text-brand-700"
            >
              {department.name}
            </Link>
          ) : (
            <span className="text-gray-400">{task.departmentId.slice(0, 8)}&hellip;</span>
          )}
        </MetaField>
        <MetaField label="Agent">
          {agent ? (
            <Link
              href={`/agents/${agent.id}`}
              className="text-brand-600 hover:text-brand-700"
            >
              {agent.name}
            </Link>
          ) : task.agentId ? (
            <span className="text-gray-400">{task.agentId.slice(0, 8)}&hellip;</span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </MetaField>
        <MetaField label="Retries">
          {task.retryCount} / {task.maxRetries}
        </MetaField>
        <MetaField label="Timeout">
          {Math.round(task.timeoutSeconds / 60)} min
        </MetaField>
      </div>

      {/* Timeline */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Timeline
        </h2>
        <Timeline task={task} isFailed={isFailed} />
      </section>

      {/* Input */}
      {task.input && Object.keys(task.input).length > 0 && (
        <JsonSection
          title="Input"
          data={task.input}
          page={0}
          onPageChange={() => {}}
          showPager={false}
        />
      )}

      {/* Output */}
      {task.output && Object.keys(task.output).length > 0 && (
        <JsonSection
          title="Output"
          data={task.output}
          page={outputPage}
          onPageChange={setOutputPage}
          showPager
        />
      )}

      {/* Error */}
      {task.error && Object.keys(task.error).length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-red-500 uppercase tracking-wider mb-3">
            Error
          </h2>
          <pre className="bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-800 overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify(task.error, null, 2)}
          </pre>
        </section>
      )}

      {/* Back link */}
      <div className="pt-2">
        <button
          onClick={() => router.back()}
          className="text-sm text-gray-500 hover:text-gray-900"
        >
          &larr; Back
        </button>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

const TIMELINE_STEPS: Array<{ key: string; label: string }> = [
  { key: "createdAt", label: "Created" },
  { key: "startedAt", label: "Running" },
  { key: "completedAt", label: "Completed" },
];

function Timeline({ task, isFailed }: { task: Task; isFailed: boolean }) {
  const lastStep = isFailed ? "Failed" : null;

  return (
    <ol className="relative ml-3 border-l border-gray-200 space-y-4 pb-1">
      {TIMELINE_STEPS.map(({ key, label }) => {
        const ts = task[key as keyof Task] as string | null;
        if (!ts && key !== "createdAt") return null;
        return (
          <li key={key} className="ml-4">
            <span className="absolute -left-1.5 mt-1 flex h-3 w-3 rounded-full border-2 border-brand-500 bg-white" />
            <p className="text-sm font-medium text-gray-900">{label}</p>
            <time className="text-xs text-gray-400">
              {ts ? new Date(ts).toLocaleString() : "—"}
            </time>
          </li>
        );
      })}
      {isFailed && task.completedAt && (
        <li className="ml-4">
          <span className="absolute -left-1.5 mt-1 flex h-3 w-3 rounded-full border-2 border-red-500 bg-white" />
          <p className="text-sm font-medium text-red-600">{lastStep}</p>
          <time className="text-xs text-gray-400">
            {new Date(task.completedAt).toLocaleString()}
          </time>
        </li>
      )}
    </ol>
  );
}

const PAGE_SIZE = 50; // keys per page

function JsonSection({
  title,
  data,
  page,
  onPageChange,
  showPager,
}: {
  title: string;
  data: Record<string, unknown>;
  page: number;
  onPageChange: (p: number) => void;
  showPager: boolean;
}) {
  const keys = Object.keys(data);
  const totalPages = Math.ceil(keys.length / PAGE_SIZE);
  const slicedKeys = keys.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const sliced = Object.fromEntries(slicedKeys.map((k) => [k, data[k]]));

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
          {title}
          {showPager && totalPages > 1 && (
            <span className="ml-2 text-gray-400 normal-case font-normal">
              ({keys.length} keys)
            </span>
          )}
        </h2>
        {showPager && totalPages > 1 && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <button
              onClick={() => onPageChange(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
            >
              Prev
            </button>
            <span>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
            >
              Next
            </button>
          </div>
        )}
      </div>
      <pre className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
        {JSON.stringify(sliced, null, 2)}
      </pre>
    </section>
  );
}

function MetaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-gray-400 uppercase tracking-wider">{label}</p>
      <div className="mt-0.5 font-medium text-gray-800">{children}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-gray-100 text-gray-600",
    queued: "bg-blue-100 text-blue-700",
    running: "bg-indigo-100 text-indigo-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
    retrying: "bg-yellow-100 text-yellow-700",
    cancelled: "bg-gray-100 text-gray-500",
    escalated: "bg-orange-100 text-orange-700",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
        map[status] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {status}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    critical: "bg-red-100 text-red-700",
    high: "bg-orange-100 text-orange-700",
    medium: "bg-yellow-100 text-yellow-700",
    low: "bg-gray-100 text-gray-500",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
        map[priority] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {priority}
    </span>
  );
}
