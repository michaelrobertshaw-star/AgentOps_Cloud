import { Router } from "express";
import { checkMinioHealth } from "../services/storageService.js";

export function healthRoutes() {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  router.get("/minio", async (_req, res) => {
    const result = await checkMinioHealth();
    const status = result.healthy ? 200 : 503;
    res.status(status).json({
      status: result.healthy ? "ok" : "error",
      minio: result,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
