import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Catch-all proxy for /api/agents/:id/workspace/* routes.
 * Reads the httpOnly access_token cookie (which client JS can't access)
 * and forwards it as a Bearer token to the Express backend.
 */
async function proxyToBackend(
  request: NextRequest,
  agentId: string,
  subpath: string[],
) {
  const cookieStore = await cookies();
  const token = cookieStore.get("access_token")?.value;
  if (!token) {
    return NextResponse.json(
      { error: "Not authenticated — please log in" },
      { status: 401 },
    );
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

  const response = await fetch(url.toString(), { method, headers, body });
  const text = await response.text();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return NextResponse.json(data, { status: response.status });
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
