import { jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { JwtPayload } from "@agentops/shared";

const ACCESS_TOKEN_COOKIE = "access_token";
const REFRESH_TOKEN_COOKIE = "refresh_token";

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET ?? "dev-jwt-secret-change-in-production";
  return new TextEncoder().encode(secret);
}

export async function verifyAccessToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), {
      issuer: process.env.JWT_ISSUER ?? "agentops.cloud",
      audience: process.env.JWT_AUDIENCE ?? "agentops-api",
    });
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<JwtPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!token) return null;
  return verifyAccessToken(token);
}

export async function requireSession(): Promise<JwtPayload> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * requireAdmin — verifies the session AND that the caller holds the
 * platform-level `oneops_admin` role.  Regular customer users are
 * redirected to the dashboard instead of seeing an error page.
 */
export async function requireAdmin(): Promise<JwtPayload> {
  const session = await requireSession();
  if (!session.roles?.includes("oneops_admin")) {
    redirect("/dashboard");
  }
  return session;
}

export interface LoginResult {
  user: { id: string; email: string; name: string; role: string };
  accessToken: string;
  refreshToken: string;
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export const ACCESS_COOKIE = ACCESS_TOKEN_COOKIE;
export const REFRESH_COOKIE = REFRESH_TOKEN_COOKIE;
export const ACCESS_TOKEN_TTL = 900; // 15 min
export const REFRESH_TOKEN_TTL = 604800; // 7 days
