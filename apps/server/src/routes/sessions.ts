import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { NotFoundError } from "../lib/errors.js";
import { listActiveSessions, revokeSession, revokeAllSessions } from "../services/sessionService.js";

export function sessionRoutes() {
  const router = Router();

  // All session routes require authentication
  router.use(authenticate());

  // GET /auth/sessions — list active sessions for the current user
  router.get("/sessions", async (req, res, next) => {
    try {
      const sessions = await listActiveSessions(req.userId!);
      res.json({ sessions });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /auth/sessions/:id — revoke a specific session
  router.delete("/sessions/:id", async (req, res, next) => {
    try {
      const ok = await revokeSession(req.params.id, req.userId!);
      if (!ok) return next(new NotFoundError("Session not found"));
      res.json({ message: "Session revoked" });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /auth/sessions — revoke all sessions (except optionally one)
  //   Body: { exceptSessionId?: string }
  router.delete("/sessions", async (req, res, next) => {
    try {
      const exceptSessionId: string | undefined =
        typeof req.body?.exceptSessionId === "string" ? req.body.exceptSessionId : undefined;
      const count = await revokeAllSessions(req.userId!, exceptSessionId);
      res.json({ message: `${count} session(s) revoked`, count });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
