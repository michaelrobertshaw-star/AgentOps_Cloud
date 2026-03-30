import type { Request, Response, NextFunction } from "express";
import { AppError } from "../lib/errors.js";

export function errorHandler() {
  return (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details && { details: err.details }),
        },
      });
      return;
    }

    // Unexpected errors
    console.error("Unhandled error:", err);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    });
  };
}
