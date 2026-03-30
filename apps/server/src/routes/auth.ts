import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import * as authService from "../services/authService.js";

const registerSchema = z.object({
  companyName: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9_-]+$/, "Company name must be lowercase alphanumeric with hyphens/underscores"),
  companyDisplayName: z.string().min(2).max(255),
  email: z.string().email().max(255),
  name: z.string().min(1).max(255),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export function authRoutes() {
  const router = Router();

  // POST /auth/register
  router.post("/register", validate(registerSchema), async (req, res, next) => {
    try {
      const { company } = await authService.registerCompanyAndUser(req.body);

      // Auto-login after registration
      const loginResult = await authService.login(req.body.email, req.body.password);

      res.status(201).json({
        company: {
          id: company.id,
          name: company.name,
          displayName: company.displayName,
        },
        user: loginResult.user,
        accessToken: loginResult.accessToken,
        refreshToken: loginResult.refreshToken,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/login
  router.post("/login", validate(loginSchema), async (req, res, next) => {
    try {
      const result = await authService.login(req.body.email, req.body.password);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/refresh
  router.post("/refresh", validate(refreshSchema), async (req, res, next) => {
    try {
      const result = await authService.refreshAccessToken(req.body.refreshToken);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/logout
  router.post("/logout", async (req, res, next) => {
    try {
      const { refreshToken } = req.body;
      if (refreshToken) {
        await authService.logout(refreshToken);
      }
      res.json({ message: "Logged out" });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
