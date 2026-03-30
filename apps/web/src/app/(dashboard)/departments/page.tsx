import { requireSession } from "@/lib/auth";
import { apiFetch } from "@/lib/api";

interface Department {
  id: string;
  name: string;
  description: string | null;
  status: string;
  managerUserId: string | null;
  createdAt: string;
}

export default async function DepartmentsPage() {
  await requireSession();

  let departments: Department[] = [];
  let error: string | null = null;
  try {
    departments = await apiFetch<Department[]>("/api/departments");
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load departments";
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Departments</h1>
      {error ? (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : departments.length === 0 ? (
        <p className="text-sm text-gray-400">No departments found.</p>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Description
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {departments.map((dept) => (
                <tr key={dept.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{dept.name}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={dept.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 max-w-xs truncate">
                    {dept.description ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {new Date(dept.createdAt).toLocaleString()}
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
    active: "bg-green-100 text-green-700",
    archived: "bg-gray-100 text-gray-500",
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
