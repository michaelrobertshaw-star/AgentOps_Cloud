import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { TaskDetailClient } from "./TaskDetailClient";

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

interface Department {
  id: string;
  name: string;
}

interface Agent {
  id: string;
  name: string;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TaskDetailPage({ params }: PageProps) {
  const { id } = await params;
  await requireSession();

  let task: Task;
  try {
    task = await apiFetch<Task>(`/api/tasks/${id}`);
  } catch {
    notFound();
  }

  // Fetch related entities in parallel (best-effort)
  const [department, agent] = await Promise.all([
    apiFetch<Department>(`/api/departments/${task.departmentId}`).catch(() => null),
    task.agentId
      ? apiFetch<Agent>(`/api/agents/${task.agentId}`).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <TaskDetailClient
      task={task}
      department={department}
      agent={agent}
    />
  );
}
