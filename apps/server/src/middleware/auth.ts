import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../services/authService.js";
import { UnauthorizedError } from "../lib/errors.js";

export function authenticate() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const cookieHeader = req.headers.cookie ?? "";

    // Accept Bearer token from Authorization header OR access_token cookie
    // (cookie path supports client-side fetches proxied through Next.js)
    let token: string | undefined;
    if (header?.startsWith("Bearer ")) {
      token = header.slice(7);
    } else {
      const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/);
      token = match?.[1] ? decodeURIComponent(match[1]) : undefined;
    }

    if (!token) {
      return next(new UnauthorizedError("Missing or invalid Authorization header"));
    }
    try {
      const payload = await verifyAccessToken(token);
      req.auth = payload;
      req.companyId = payload.company_id;
      req.userId = payload.sub.replace("user:", "");

      // Admin tenant override: if the user is oneops_admin and has selected
      // a different tenant via the TenantSwitcher, honour that selection.
      if (payload.roles?.includes("oneops_admin")) {
        // Check X-Tenant-Id header first, then x_tenant_id cookie
        const tenantHeader = req.headers["x-tenant-id"] as string | undefined;
        const tenantCookie = cookieHeader.match(/(?:^|;\s*)x_tenant_id=([^;]+)/)?.[1];
        const overrideTenant = tenantHeader ?? (tenantCookie ? decodeURIComponent(tenantCookie) : undefined);
        if (overrideTenant && overrideTenant !== payload.company_id) {
          req.companyId = overrideTenant;
        }
      }

      next();
    } catch {
      next(new UnauthorizedError("Invalid or expired token"));
    }
  };
}
