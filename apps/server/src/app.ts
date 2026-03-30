import express from "express";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { companyRoutes } from "./routes/companies.js";
import { departmentRoutes } from "./routes/departments.js";
import { auditRoutes, auditCompanyRoutes, auditArchiveCompanyRoutes } from "./routes/audit.js";
import { agentRoutes } from "./routes/agents.js";
import { agentKeyRoutes } from "./routes/agentKeys.js";
import { taskRoutes } from "./routes/tasks.js";
import { agentCheckinRoutes } from "./routes/agentCheckin.js";
import { taskRunRoutes } from "./routes/taskRuns.js";
import { workspaceRoutes, workspaceDeptRoutes, workspaceFileRoutes } from "./routes/workspaces.js";
import { incidentDeptRoutes, incidentRoutes } from "./routes/incidents.js";
import { webhookCompanyRoutes, webhookRoutes } from "./routes/webhooks.js";
import { sessionRoutes } from "./routes/sessions.js";
import { requestId } from "./middleware/requestId.js";
import { auditMiddleware } from "./middleware/audit.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";

export function createApp() {
  const app = express();

  // Global middleware
  app.use(express.json());
  app.use(requestId());
  app.use(rateLimitMiddleware());
  app.use(auditMiddleware());

  // Public routes
  app.use("/api/health", healthRoutes());
  app.use("/api/auth", authRoutes());
  app.use("/api/auth", sessionRoutes());
  app.use("/api/agent", agentCheckinRoutes());

  // Authenticated routes
  app.use("/api/companies", companyRoutes());
  app.use("/api/departments", departmentRoutes());
  app.use("/api/agents", agentRoutes());
  app.use("/api/agents/:agentId/keys", agentKeyRoutes());
  app.use("/api/tasks", taskRoutes());
  app.use("/api/tasks/:taskId/runs", taskRunRoutes());
  app.use("/api/audit-logs", auditRoutes());
  app.use("/api/departments/:deptId/workspaces", workspaceDeptRoutes());
  app.use("/api/workspaces", workspaceRoutes());
  app.use("/api/workspaces/:workspaceId/files", workspaceFileRoutes());
  app.use("/api/departments/:deptId/incidents", incidentDeptRoutes());
  app.use("/api/incidents", incidentRoutes());
  app.use("/api/companies/:companyId/audit-logs", auditCompanyRoutes());
  app.use("/api/companies/:companyId/audit", auditArchiveCompanyRoutes());
  app.use("/api/companies/:companyId/webhooks", webhookCompanyRoutes());
  app.use("/api/webhooks", webhookRoutes());

  // Error handler (must be last)
  app.use(errorHandler());

  return app;
}
