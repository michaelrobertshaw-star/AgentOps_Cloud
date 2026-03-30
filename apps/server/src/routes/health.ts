import { Router } from "express";

export function healthRoutes() {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return router;
}
