import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../services/authService.js";
import { UnauthorizedError } from "../lib/errors.js";

export function authenticate() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return next(new UnauthorizedError("Missing or invalid Authorization header"));
    }

    const token = header.slice(7);
    try {
      const payload = await verifyAccessToken(token);
      req.auth = payload;
      req.companyId = payload.company_id;
      req.userId = payload.sub.replace("user:", "");
      next();
    } catch {
      next(new UnauthorizedError("Invalid or expired token"));
    }
  };
}
