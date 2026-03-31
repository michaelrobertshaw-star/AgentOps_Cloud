import { requireSession } from "@/lib/auth";
import { TopNav } from "@/components/TopNav";
import { Sidebar } from "@/components/Sidebar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <TopNav session={session} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar roles={session.roles} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
