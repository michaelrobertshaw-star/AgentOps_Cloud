import express from "express";
import { healthRoutes } from "./routes/health.js";

export function createApp() {
  const app = express();

  app.use(express.json());

  app.use("/api/health", healthRoutes());

  return app;
}
