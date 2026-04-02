/**
 * Client-side fetch wrapper that injects the X-Tenant-Id header
 * when an admin has selected a different tenant via the TenantSwitcher.
 */
export function fetchWithTenant(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);

  // Read the x_tenant_id cookie (this one is NOT httpOnly, so JS can read it)
  if (typeof document !== "undefined") {
    const match = document.cookie.match(/(?:^|;\s*)x_tenant_id=([^;]+)/);
    if (match?.[1]) {
      headers.set("X-Tenant-Id", decodeURIComponent(match[1]));
    }
  }

  return fetch(input, { ...init, headers, credentials: "include" });
}
