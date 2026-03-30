"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  cookieOptions,
  type LoginResult,
} from "@/lib/auth";

export async function loginAction(formData: FormData) {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const rawFrom = (formData.get("from") as string) || "/";
  // Validate that redirect target is a relative path to prevent open redirect
  const from = rawFrom.startsWith("/") && !rawFrom.startsWith("//") ? rawFrom : "/";

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

  const res = await fetch(`${apiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = encodeURIComponent(
      (body as { error?: string }).error ?? "Invalid email or password",
    );
    redirect(`/login?error=${message}&from=${encodeURIComponent(from)}`);
  }

  const data = (await res.json()) as LoginResult;

  const cookieStore = await cookies();
  cookieStore.set(ACCESS_COOKIE, data.accessToken, cookieOptions(ACCESS_TOKEN_TTL));
  cookieStore.set(REFRESH_COOKIE, data.refreshToken, cookieOptions(REFRESH_TOKEN_TTL));

  redirect(from);
}
