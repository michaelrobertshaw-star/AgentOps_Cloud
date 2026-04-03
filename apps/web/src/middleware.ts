import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const PUBLIC_PATHS = ["/login", "/register"];

// Routes that require the platform-level oneops_admin role
const ADMIN_PATHS = ["/admin"];

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET ?? "dev-jwt-secret-change-in-production";
  return new TextEncoder().encode(secret);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    // If already authed, redirect away from login
    const token = request.cookies.get("access_token")?.value;
    if (token) {
      try {
        await jwtVerify(token, getJwtSecret(), {
          issuer: process.env.JWT_ISSUER ?? "agentops.cloud",
          audience: process.env.JWT_AUDIENCE ?? "agentops-api",
        });
        return NextResponse.redirect(new URL("/", request.url));
      } catch {
        // Token invalid — let them see the login page
      }
    }
    return NextResponse.next();
  }

  // Protect all other routes
  const token = request.cookies.get("access_token")?.value;
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, getJwtSecret(), {
      issuer: process.env.JWT_ISSUER ?? "agentops.cloud",
      audience: process.env.JWT_AUDIENCE ?? "agentops-api",
    });
    payload = result.payload as Record<string, unknown>;
  } catch {
    // Access token expired or invalid — try to refresh using the refresh token
    const refreshToken = request.cookies.get("refresh_token")?.value;
    if (refreshToken) {
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
        const refreshRes = await fetch(`${apiUrl}/api/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json() as { accessToken: string; refreshToken: string };
          // Verify the new token
          const result = await jwtVerify(data.accessToken, getJwtSecret(), {
            issuer: process.env.JWT_ISSUER ?? "agentops.cloud",
            audience: process.env.JWT_AUDIENCE ?? "agentops-api",
          });
          payload = result.payload as Record<string, unknown>;

          // Set new cookies on the response and continue
          const response = NextResponse.next();
          response.headers.set("x-pathname", pathname);
          const isProduction = process.env.NODE_ENV === "production";
          response.cookies.set("access_token", data.accessToken, {
            httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: 900,
          });
          response.cookies.set("refresh_token", data.refreshToken, {
            httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: 604800,
          });

          // Enforce role-based access on admin routes
          if (ADMIN_PATHS.some((p) => pathname.startsWith(p))) {
            const roles = (payload as { roles?: string[] }).roles ?? [];
            if (!roles.includes("oneops_admin")) {
              return NextResponse.redirect(new URL("/dashboard", request.url));
            }
          }

          return response;
        }
      } catch {
        // Refresh failed — fall through to login redirect
      }
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    const response = NextResponse.redirect(loginUrl);
    response.cookies.delete("access_token");
    response.cookies.delete("refresh_token");
    return response;
  }

  // Enforce role-based access on admin routes
  if (ADMIN_PATHS.some((p) => pathname.startsWith(p))) {
    const roles = (payload as { roles?: string[] }).roles ?? [];
    if (!roles.includes("oneops_admin")) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  const response = NextResponse.next();
  response.headers.set("x-pathname", pathname);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
