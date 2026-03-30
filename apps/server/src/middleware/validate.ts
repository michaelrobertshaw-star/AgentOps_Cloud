import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";
import { ValidationError } from "../lib/errors.js";

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.flatten();
      return next(
        new ValidationError("Validation failed", {
          fieldErrors: errors.fieldErrors,
          formErrors: errors.formErrors,
        }),
      );
    }
    req.body = result.data;
    next();
  };
}
