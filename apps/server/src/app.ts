import express from "express";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { companyRoutes } from "./routes/companies.js";
import { departmentRoutes } from "./routes/departments.js";
import { auditRoutes } from "./routes/audit.js";
import { requestId } from "./middleware/requestId.js";
import { auditMiddleware } from "./middleware/audit.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();

  // Global middleware
  app.use(express.json());
  app.use(requestId());
  app.use(auditMiddleware());

  // Public routes
  app.use("/api/health", healthRoutes());
  app.use("/api/auth", authRoutes());

  // Authenticated routes
  app.use("/api/companies", companyRoutes());
  app.use("/api/departments", departmentRoutes());
  app.use("/api/audit-logs", auditRoutes());

  // Error handler (must be last)
  app.use(errorHandler());

  return app;
}
