import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Catch-all proxy for /api/workspace/* routes (templates, runs/files).
 * Reads httpOnly access_token cookie server-side and forwards as Bearer token.
 */
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

async function proxyToBackend(request: NextRequest, subpath: string[]) {
  const cookieStore = await cookies();
  let token = cookieStore.get("access_token")?.value;
  let refreshedTokens: { accessToken: string; refreshToken: string } | null = null;

  if (!token) {
    // Try refresh before giving up
    refreshedTokens = await tryRefreshToken();
    if (!refreshedTokens) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    token = refreshedTokens.accessToken;
  }

  const backendPath = `/api/workspace/${subpath.join("/")}`;
  const url = new URL(backendPath, BACKEND);
  const qs = request.nextUrl.search;
  if (qs) url.search = qs;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const tenant = request.headers.get("x-tenant-id");
  if (tenant) headers["X-Tenant-Id"] = tenant;

  const method = request.method;
  let body: ArrayBuffer | string | undefined;

  if (method !== "GET" && method !== "HEAD") {
    const ct = request.headers.get("content-type") || "";
    headers["Content-Type"] = ct;

    if (ct.includes("application/pdf") || ct.includes("octet-stream")) {
      body = await request.arrayBuffer();
    } else {
      body = await request.text();
    }
  }

  let response = await fetch(url.toString(), {
    method,
    headers,
    body: body ? (body instanceof ArrayBuffer ? Buffer.from(body) : body) : undefined,
  });

  // If 401 and we haven't refreshed yet, try refreshing and retry once
  if (response.status === 401 && !refreshedTokens) {
    refreshedTokens = await tryRefreshToken();
    if (refreshedTokens) {
      token = refreshedTokens.accessToken;
      headers.Authorization = `Bearer ${token}`;
      response = await fetch(url.toString(), {
        method,
        headers,
        body: body ? (body instanceof ArrayBuffer ? Buffer.from(body) : body) : undefined,
      });
    }
  }

  // If we refreshed tokens, set new cookies on the outgoing response
  function applyRefreshedCookies(resp: NextResponse) {
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

  const respCt = response.headers.get("content-type") || "";
  if (respCt.includes("application/pdf")) {
    const buf = await response.arrayBuffer();
    return applyRefreshedCookies(new NextResponse(buf, {
      status: response.status,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": response.headers.get("content-disposition") || "inline",
      },
    }));
  }

  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return applyRefreshedCookies(NextResponse.json(data, { status: response.status }));
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToBackend(req, path);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToBackend(req, path);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToBackend(req, path);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToBackend(req, path);
}

// Increase body size limit for PDF uploads (base64 JSON can be several MB)
export const maxDuration = 60;
export const dynamic = "force-dynamic";
