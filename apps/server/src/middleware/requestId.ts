import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = (req.headers["x-request-id"] as string) || crypto.randomUUID();
    req.requestId = id;
    res.setHeader("X-Request-Id", id);
    next();
  };
}
