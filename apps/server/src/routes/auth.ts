import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { authenticate } from "../middleware/auth.js";
import * as authService from "../services/authService.js";
import * as mfaService from "../services/mfaService.js";

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

const mfaVerifySchema = z.object({
  code: z.string().length(6).regex(/^\d{6}$/, "TOTP code must be 6 digits"),
});

const mfaRecoverSchema = z.object({
  recoveryCode: z.string().min(1),
});

const mfaChallengeSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().length(6).regex(/^\d{6}$/, "TOTP code must be 6 digits"),
});

export function authRoutes() {
  const router = Router();

  // POST /auth/register
  router.post("/register", validate(registerSchema), async (req, res, next) => {
    try {
      const { company } = await authService.registerCompanyAndUser(req.body);

      // Auto-login after registration
      const loginResult = await authService.login(req.body.email, req.body.password, {
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });

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
      const result = await authService.login(req.body.email, req.body.password, {
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
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

  // POST /auth/mfa/challenge — complete login when MFA is required
  router.post("/mfa/challenge", validate(mfaChallengeSchema), async (req, res, next) => {
    try {
      const result = await authService.loginMfaChallenge(req.body.mfaToken, req.body.code, {
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/mfa/enroll — generate TOTP secret + QR URI (requires authentication)
  router.post("/mfa/enroll", authenticate(), async (req, res, next) => {
    try {
      const result = await mfaService.enrollMfa(req.userId!, req.companyId!);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/mfa/verify — validate TOTP code and activate MFA (requires authentication)
  router.post("/mfa/verify", authenticate(), validate(mfaVerifySchema), async (req, res, next) => {
    try {
      await mfaService.verifyMfaEnrollment(req.userId!, req.body.code);
      res.json({ message: "MFA activated successfully" });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/mfa/recover — use a recovery code to disable MFA (requires authentication)
  router.post("/mfa/recover", authenticate(), validate(mfaRecoverSchema), async (req, res, next) => {
    try {
      await mfaService.recoverMfa(req.userId!, req.companyId!, req.body.recoveryCode);
      res.json({ message: "MFA disabled via recovery code" });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
