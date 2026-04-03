import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

// Allow long-running pipeline executions — large date-range pulls can fetch 10,000+ records
export const maxDuration = 300;

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function tryRefreshToken(): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const cookieStore = await cookies();
    const refreshToken = cookieStore.get("refresh_token")?.value;
    if (!refreshToken) return null;
    const res = await fetch(`${BACKEND}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { accessToken: string; refreshToken: string };
  } catch {
    return null;
  }
}

/**
 * Catch-all proxy for /api/agents/:id/workspace/* routes.
 * Reads the httpOnly access_token cookie (which client JS can't access)
 * and forwards it as a Bearer token to the Express backend.
 * Auto-refreshes expired tokens using the refresh_token cookie.
 */
async function proxyToBackend(
  request: NextRequest,
  agentId: string,
  subpath: string[],
) {
  const cookieStore = await cookies();
  const allCookies = cookieStore.getAll();
  console.log(`[workspace-proxy] path=/${subpath.join("/")} cookies=[${allCookies.map(c => c.name).join(", ") || "NONE"}]`);
  let token = cookieStore.get("access_token")?.value;
  console.log(`[workspace-proxy] access_token present: ${!!token}, length: ${token?.length ?? 0}`);
  let refreshedTokens: { accessToken: string; refreshToken: string } | null = null;

  if (!token) {
    console.log(`[workspace-proxy] No access_token, attempting refresh...`);
    refreshedTokens = await tryRefreshToken();
    if (!refreshedTokens) {
      console.log(`[workspace-proxy] Refresh also failed — returning 401`);
      return NextResponse.json(
        { error: "Not authenticated — please log in" },
        { status: 401 },
      );
    }
    token = refreshedTokens.accessToken;
    console.log(`[workspace-proxy] Refreshed successfully, new token length: ${token.length}`);
  }

  const backendPath = `/api/agents/${agentId}/workspace/${subpath.join("/")}`;
  const url = new URL(backendPath, BACKEND);

  // Forward query string
  const qs = request.nextUrl.search;
  if (qs) url.search = qs;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  // Forward tenant header if present
  const tenant = request.headers.get("x-tenant-id");
  if (tenant) headers["X-Tenant-Id"] = tenant;

  const method = request.method;
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    body = await request.text();
  }

  // Use a generous timeout — pipeline execution (PULL + PARSE + CREATE) can take 60s+
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 270_000); // 4.5min — large pulls may fetch 10k+ records

  let response: Response;
  try {
    response = await fetch(url.toString(), { method, headers, body, signal: controller.signal });

    // If 401 and we haven't refreshed yet, try refreshing and retry once
    if (response.status === 401 && !refreshedTokens) {
      refreshedTokens = await tryRefreshToken();
      if (refreshedTokens) {
        token = refreshedTokens.accessToken;
        headers.Authorization = `Bearer ${token}`;
        response = await fetch(url.toString(), { method, headers, body, signal: controller.signal });
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  const resp = NextResponse.json(data, { status: response.status });

  // If we refreshed tokens, set new cookies on the outgoing response
  if (refreshedTokens) {
    const isProduction = process.env.NODE_ENV === "production";
    resp.cookies.set("access_token", refreshedTokens.accessToken, {
      httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: 900,
    });
    resp.cookies.set("refresh_token", refreshedTokens.refreshToken, {
      httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: 604800,
    });
  }

  return resp;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path } = await params;
  return proxyToBackend(request, id, path);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path } = await params;
  return proxyToBackend(request, id, path);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path } = await params;
  return proxyToBackend(request, id, path);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path } = await params;
  return proxyToBackend(request, id, path);
}
