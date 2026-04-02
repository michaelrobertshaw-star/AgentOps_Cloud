"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";

interface Tenant {
  id: string;
  name: string;
  displayName: string;
  status: string;
}

interface Props {
  isAdmin: boolean;
  currentCompanyId: string;
}

/**
 * TenantSwitcher — Admin-only dropdown that lists all active tenants.
 * Switching tenants navigates to /admin/companies/{id}/view (if that page exists)
 * or stores the selected tenantId in sessionStorage for use across admin views.
 */
function readTenantCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)x_tenant_id=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function TenantSwitcher({ isAdmin, currentCompanyId }: Props) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  // Initialise from the cookie so the selection survives page reloads
  const [selected, setSelected] = useState<string>(() => readTenantCookie() || currentCompanyId);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    fetch("/api/admin/companies?limit=100")
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((data: { data?: Tenant[] } | Tenant[]) => {
        const list = Array.isArray(data) ? data : (data.data ?? []);
        setTenants(list.filter((t) => t.status === "active"));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isAdmin]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Persist selected tenant as a cookie so it's sent with every API fetch
  useEffect(() => {
    if (selected) {
      sessionStorage.setItem("admin_viewing_tenant", selected);
      // Set cookie for backend auth middleware to read
      document.cookie = `x_tenant_id=${encodeURIComponent(selected)}; path=/; SameSite=Lax`;
    }
  }, [selected]);

  const selectedTenant = tenants.find((t) => t.id === selected);

  if (!isAdmin) {
    // Non-admins: show simple company badge
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-100 text-sm font-medium text-gray-700 truncate max-w-[200px]">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-brand-600 text-xs font-bold text-white uppercase">
          {currentCompanyId.slice(0, 2)}
        </span>
        <span className="truncate">{currentCompanyId.slice(0, 8)}&hellip;</span>
      </div>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm font-medium text-gray-700 transition-colors"
      >
        <span className="text-xs text-gray-400">Viewing:</span>
        <span className="font-semibold text-gray-800 truncate max-w-[120px]">
          {loading ? "Loading..." : selectedTenant?.displayName ?? currentCompanyId.slice(0, 8)}
        </span>
        <span className="text-gray-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-50 max-h-80 overflow-y-auto">
          <div className="p-2">
            <p className="text-xs text-gray-400 px-2 py-1 uppercase tracking-wider">Switch Tenant</p>
            {tenants.length === 0 ? (
              <p className="text-sm text-gray-400 px-2 py-2">No tenants found</p>
            ) : (
              tenants.map((tenant) => (
                <button
                  key={tenant.id}
                  onClick={() => {
                    setSelected(tenant.id);
                    setOpen(false);
                    // Set cookie immediately before reload
                    document.cookie = `x_tenant_id=${encodeURIComponent(tenant.id)}; path=/; SameSite=Lax`;
                    // Full page reload so all client components re-fetch with new tenant cookie
                    window.location.reload();
                  }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                    tenant.id === selected
                      ? "bg-brand-50 text-brand-700 font-medium"
                      : "hover:bg-gray-50 text-gray-700"
                  }`}
                >
                  <p className="font-medium">{tenant.displayName}</p>
                  <p className="text-xs text-gray-400 font-mono">{tenant.id.slice(0, 8)}&hellip;</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
