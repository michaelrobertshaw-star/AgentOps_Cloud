"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: "⊞" },
  { href: "/departments", label: "Departments", icon: "⊟" },
  { href: "/agents", label: "Agents", icon: "◈" },
  { href: "/tasks", label: "Tasks", icon: "◫" },
  { href: "/incidents", label: "Incidents", icon: "⚡" },
  { href: "/audit", label: "Audit Log", icon: "◧" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 flex flex-col bg-gray-900 text-gray-300 min-h-full">
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon }) => {
          const active = pathname === href || (href !== "/" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                active
                  ? "bg-brand-700 text-white"
                  : "hover:bg-gray-800 hover:text-white"
              }`}
            >
              <span className="text-base leading-none">{icon}</span>
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
