import { requireSession } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import Link from "next/link";

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  departmentId: string;
  createdAt: string;
}

export default async function TasksPage() {
  await requireSession();

  let tasks: Task[] = [];
  try {
    tasks = await apiFetch<Task[]>("/api/tasks");
  } catch {
    tasks = [];
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Tasks</h1>
      {tasks.length === 0 ? (
        <p className="text-sm text-gray-400">No tasks found.</p>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Title
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Priority
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {tasks.map((t) => (
                <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      href={`/tasks/${t.id}`}
                      className="font-medium text-brand-600 hover:text-brand-700"
                    >
                      {t.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{t.priority}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {new Date(t.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
