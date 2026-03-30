import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  pgEnum,
  boolean,
  integer,
  bigint,
  jsonb,
  inet,
  uniqueIndex,
  index,
  decimal,
} from "drizzle-orm/pg-core";

// ================================================================
// ENUMS
// ================================================================

export const companyStatusEnum = pgEnum("company_status", [
  "active",
  "suspended",
  "deactivated",
]);

export const userStatusEnum = pgEnum("user_status", ["active", "invited", "deactivated"]);

export const userRoleEnum = pgEnum("user_role", [
  "company_admin",
  "technical_admin",
  "auditor",
]);

export const departmentStatusEnum = pgEnum("department_status", ["active", "archived"]);

export const departmentRoleEnum = pgEnum("department_role", [
  "department_manager",
  "operator",
  "viewer",
]);

export const agentStatusEnum = pgEnum("agent_status", [
  "draft",
  "testing",
  "tested",
  "active",
  "degraded",
  "paused",
  "stopped",
  "error",
  "archived",
  "deployed",
  "disabled",
]);

export const apiKeyStatusEnum = pgEnum("api_key_status", ["active", "revoked", "expired"]);

export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "retrying",
  "escalated",
  "cancelled",
]);

export const taskPriorityEnum = pgEnum("task_priority", [
  "critical",
  "high",
  "medium",
  "low",
]);

export const taskRunStatusEnum = pgEnum("task_run_status", [
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const workspaceStatusEnum = pgEnum("workspace_status", [
  "active",
  "archived",
  "deleted",
]);

export const incidentSeverityEnum = pgEnum("incident_severity", [
  "critical",
  "high",
  "medium",
  "low",
]);

export const incidentStatusEnum = pgEnum("incident_status", [
  "open",
  "investigating",
  "mitigated",
  "resolved",
  "closed",
]);

export const auditActorTypeEnum = pgEnum("audit_actor_type", ["user", "agent", "system"]);

export const auditOutcomeEnum = pgEnum("audit_outcome", ["success", "failure", "denied"]);

export const auditRiskLevelEnum = pgEnum("audit_risk_level", [
  "critical",
  "high",
  "medium",
  "low",
]);

export const webhookStatusEnum = pgEnum("webhook_status", ["active", "paused", "failed"]);

// ================================================================
// COMPANIES (Tenants)
// ================================================================

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 100 }).notNull().unique(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    status: companyStatusEnum("status").default("active").notNull(),
    settings: jsonb("settings").default({}).notNull(),
    timezone: varchar("timezone", { length: 50 }).default("UTC").notNull(),
    region: varchar("region", { length: 50 }),
    billingPlan: varchar("billing_plan", { length: 50 }).default("free"),
    billingCustomerId: varchar("billing_customer_id", { length: 255 }),
    auditRetentionDays: integer("audit_retention_days").default(90).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_companies_status").on(table.status),
    index("idx_companies_name").on(table.name),
  ],
);

// ================================================================
// USERS
// ================================================================

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }),
    role: userRoleEnum("role").default("auditor").notNull(),
    status: userStatusEnum("status").default("active").notNull(),
    mfaEnabled: boolean("mfa_enabled").default(false).notNull(),
    mfaSecret: varchar("mfa_secret", { length: 255 }),
    superAdmin: boolean("super_admin").default(false).notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_users_company_email").on(table.companyId, table.email),
    index("idx_users_company").on(table.companyId),
    index("idx_users_email").on(table.email),
    index("idx_users_status").on(table.companyId, table.status),
  ],
);

// ================================================================
// DEPARTMENTS
// ================================================================

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    managerUserId: uuid("manager_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: departmentStatusEnum("status").default("active").notNull(),
    settings: jsonb("settings").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_departments_company_name").on(table.companyId, table.name),
    index("idx_departments_company").on(table.companyId),
  ],
);

// ================================================================
// DEPARTMENT MEMBERSHIPS
// ================================================================

export const departmentMemberships = pgTable(
  "department_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    departmentId: uuid("department_id")
      .references(() => departments.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: departmentRoleEnum("role").default("viewer").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_dept_memberships_dept_user").on(table.departmentId, table.userId),
    index("idx_dept_memberships_user").on(table.userId),
    index("idx_dept_memberships_dept").on(table.departmentId),
    index("idx_dept_memberships_company").on(table.companyId),
  ],
);

// ================================================================
// AGENTS
// ================================================================

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    departmentId: uuid("department_id").references(() => departments.id, {
      onDelete: "set null",
    }),
    name: varchar("name", { length: 100 }).notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    version: varchar("version", { length: 50 }),
    description: text("description"),
    status: agentStatusEnum("status").default("draft").notNull(),
    executionPolicy: jsonb("execution_policy")
      .default({
        max_concurrent_tasks: 1,
        timeout_seconds: 1800,
        retry_policy: { max_retries: 3, backoff: "exponential" },
      })
      .notNull(),
    capabilities: jsonb("capabilities").default([]).notNull(),
    config: jsonb("config").default({}).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    deployedByUserId: uuid("deployed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_agents_company_name").on(table.companyId, table.name),
    index("idx_agents_company").on(table.companyId),
    index("idx_agents_department").on(table.departmentId),
    index("idx_agents_status").on(table.companyId, table.status),
  ],
);

// ================================================================
// AGENT API KEYS
// ================================================================

export const agentApiKeys = pgTable(
  "agent_api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    keyPrefix: varchar("key_prefix", { length: 12 }).notNull(),
    name: varchar("name", { length: 100 }).default("default").notNull(),
    status: apiKeyStatusEnum("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }), // grace period end for rotated keys
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_agent_keys_hash").on(table.keyHash),
    index("idx_agent_keys_agent").on(table.agentId, table.status),
    index("idx_agent_keys_prefix").on(table.keyPrefix),
  ],
);

// ================================================================
// TASKS
// ================================================================

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    departmentId: uuid("department_id")
      .references(() => departments.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    parentTaskId: uuid("parent_task_id"),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    status: taskStatusEnum("status").default("pending").notNull(),
    priority: taskPriorityEnum("priority").default("medium").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    error: jsonb("error"),
    retryCount: integer("retry_count").default(0).notNull(),
    maxRetries: integer("max_retries").default(3).notNull(),
    timeoutSeconds: integer("timeout_seconds").default(1800).notNull(),
    runTokenId: uuid("run_token_id"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_tasks_company").on(table.companyId),
    index("idx_tasks_department").on(table.departmentId),
    index("idx_tasks_agent").on(table.agentId),
    index("idx_tasks_status").on(table.companyId, table.status),
    index("idx_tasks_parent").on(table.parentTaskId),
  ],
);

// ================================================================
// TASK RUNS
// ================================================================

export const taskRuns = pgTable(
  "task_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    runNumber: integer("run_number").notNull(),
    status: taskRunStatusEnum("status").default("running").notNull(),
    outputRef: varchar("output_ref", { length: 500 }),
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_task_runs_task_number").on(table.taskId, table.runNumber),
    index("idx_task_runs_task").on(table.taskId),
    index("idx_task_runs_agent").on(table.agentId),
  ],
);

// ================================================================
// WORKSPACES
// ================================================================

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    departmentId: uuid("department_id")
      .references(() => departments.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    storagePath: varchar("storage_path", { length: 500 }).notNull(),
    storageBytes: bigint("storage_bytes", { mode: "number" }).default(0).notNull(),
    fileCount: integer("file_count").default(0).notNull(),
    status: workspaceStatusEnum("status").default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_workspaces_dept_name").on(table.departmentId, table.name),
    index("idx_workspaces_department").on(table.departmentId),
    index("idx_workspaces_company").on(table.companyId),
  ],
);

// ================================================================
// WORKSPACE FILES
// ================================================================

export const workspaceFiles = pgTable(
  "workspace_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    path: varchar("path", { length: 1000 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentType: varchar("content_type", { length: 255 }),
    storageKey: varchar("storage_key", { length: 500 }).notNull(),
    checksum: varchar("checksum", { length: 64 }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id),
    uploadedByAgentId: uuid("uploaded_by_agent_id").references(() => agents.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_workspace_files_path").on(table.workspaceId, table.path),
    index("idx_workspace_files_workspace").on(table.workspaceId),
  ],
);

// ================================================================
// INCIDENTS
// ================================================================

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    departmentId: uuid("department_id").references(() => departments.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description").notNull(),
    severity: incidentSeverityEnum("severity").notNull(),
    status: incidentStatusEnum("status").default("open").notNull(),
    resolution: text("resolution"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_incidents_company").on(table.companyId),
    index("idx_incidents_status").on(table.companyId, table.status),
  ],
);

// ================================================================
// INCIDENT ATTACHMENTS
// ================================================================

export const incidentAttachments = pgTable(
  "incident_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    incidentId: uuid("incident_id")
      .references(() => incidents.id, { onDelete: "cascade" })
      .notNull(),
    workspaceFileId: uuid("workspace_file_id")
      .references(() => workspaceFiles.id, { onDelete: "cascade" })
      .notNull(),
    attachedByUserId: uuid("attached_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_incident_attachments_unique").on(table.incidentId, table.workspaceFileId),
    index("idx_incident_attachments_incident").on(table.incidentId),
  ],
);

// ================================================================
// AUDIT LOGS
// ================================================================

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    actorType: auditActorTypeEnum("actor_type").notNull(),
    actorId: uuid("actor_id").notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    resourceType: varchar("resource_type", { length: 50 }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    departmentId: uuid("department_id"),
    context: jsonb("context").default({}).notNull(),
    changes: jsonb("changes"),
    outcome: auditOutcomeEnum("outcome").default("success").notNull(),
    riskLevel: auditRiskLevelEnum("risk_level").default("low").notNull(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    requestId: uuid("request_id"),
    entryHash: varchar("entry_hash", { length: 64 }).notNull(),
    prevHash: varchar("prev_hash", { length: 64 }), // nullable for backward compat; links to previous entry
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_audit_company_time").on(table.companyId, table.createdAt),
    index("idx_audit_actor").on(table.actorType, table.actorId, table.createdAt),
    index("idx_audit_resource").on(table.resourceType, table.resourceId),
    index("idx_audit_action").on(table.companyId, table.action),
  ],
);

// ================================================================
// MFA RECOVERY CODES
// ================================================================

export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_mfa_recovery_user").on(table.userId),
    index("idx_mfa_recovery_company").on(table.companyId),
  ],
);

// ================================================================
// SESSIONS
// ================================================================

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_sessions_user").on(table.userId),
    index("idx_sessions_expires").on(table.expiresAt),
  ],
);

// ================================================================
// WEBHOOKS
// ================================================================

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    url: varchar("url", { length: 2048 }).notNull(),
    secret: varchar("secret", { length: 255 }).notNull(),
    events: text("events").array().notNull(),
    status: webhookStatusEnum("status").default("active").notNull(),
    failureCount: integer("failure_count").default(0).notNull(),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_webhooks_company").on(table.companyId, table.status)],
);

// ================================================================
// WEBHOOK DELIVERIES
// ================================================================

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    webhookId: uuid("webhook_id")
      .references(() => webhooks.id, { onDelete: "cascade" })
      .notNull(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull(),
    statusCode: integer("status_code"),
    responseBody: text("response_body"),
    attemptNumber: integer("attempt_number").default(1).notNull(),
    success: boolean("success").notNull(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_webhook_deliveries_webhook").on(table.webhookId),
    index("idx_webhook_deliveries_company_time").on(table.companyId, table.deliveredAt),
  ],
);

// ================================================================
// CONNECTORS (M6.3)
// ================================================================

export const connectorTypeEnum = pgEnum("connector_type", [
  "claude_api",
  "claude_browser",
  "webhook",
  "http_get",
  "minio_storage",
]);

export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    type: connectorTypeEnum("type").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    // Non-secret config: model name, endpoint URL, bucket name, etc.
    config: jsonb("config").default({}).notNull(),
    // AES-256-GCM encrypted secrets: API keys, passwords, tokens.
    // Format: { iv: "<hex>", tag: "<hex>", ciphertext: "<hex>" }
    secretsEncrypted: jsonb("secrets_encrypted"),
    isDefault: boolean("is_default").default(false).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_connectors_company_name").on(table.companyId, table.name),
    index("idx_connectors_company").on(table.companyId),
    index("idx_connectors_type").on(table.companyId, table.type),
  ],
);

export const agentConnectors = pgTable(
  "agent_connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    connectorId: uuid("connector_id")
      .references(() => connectors.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_agent_connectors_unique").on(table.agentId, table.connectorId),
    index("idx_agent_connectors_agent").on(table.agentId),
    index("idx_agent_connectors_connector").on(table.connectorId),
    index("idx_agent_connectors_company").on(table.companyId),
  ],
);

// ================================================================
// AGENT RUNS (M6.4 — pre-declared here so schema is coherent)
// ================================================================

export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
]);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    // Optional link to a platform task
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    status: agentRunStatusEnum("status").default("running").notNull(),
    input: jsonb("input"),
    output: text("output"),
    model: varchar("model", { length: 100 }),
    tokensInput: integer("tokens_input").default(0).notNull(),
    tokensOutput: integer("tokens_output").default(0).notNull(),
    costUsd: decimal("cost_usd", { precision: 12, scale: 6 }),
    durationMs: integer("duration_ms"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_agent_runs_agent").on(table.agentId),
    index("idx_agent_runs_company_time").on(table.companyId, table.createdAt),
    index("idx_agent_runs_status").on(table.companyId, table.status),
  ],
);

// ================================================================
// BROWSER SESSIONS (M6.4 — computer-use / browser connector runs)
// ================================================================

export const browserSessions = pgTable(
  "browser_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentRunId: uuid("agent_run_id")
      .references(() => agentRuns.id, { onDelete: "cascade" })
      .notNull(),
    screenshots: jsonb("screenshots").default([]).notNull(),
    actions: jsonb("actions").default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_browser_sessions_run").on(table.agentRunId)],
);

// ================================================================
// COMPANY SETTINGS (M6.1)
// ================================================================

export const companySettings = pgTable(
  "company_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    value: jsonb("value").default(null).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_company_settings_company_key").on(table.companyId, table.key),
    index("idx_company_settings_company").on(table.companyId),
  ],
);

// ================================================================
// SKILLS (M6.2)
// ================================================================

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    content: jsonb("content").default({}).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_skills_company_name").on(table.companyId, table.name),
    index("idx_skills_company").on(table.companyId),
  ],
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    skillId: uuid("skill_id")
      .references(() => skills.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_agent_skills_unique").on(table.agentId, table.skillId),
    index("idx_agent_skills_agent").on(table.agentId),
    index("idx_agent_skills_skill").on(table.skillId),
    index("idx_agent_skills_company").on(table.companyId),
  ],
);

// ================================================================
// DRIZZLE RELATIONS (for query builder `with` syntax)
// ================================================================

import { relations } from "drizzle-orm";

export const agentConnectorsRelations = relations(agentConnectors, ({ one }) => ({
  connector: one(connectors, {
    fields: [agentConnectors.connectorId],
    references: [connectors.id],
  }),
  agent: one(agents, {
    fields: [agentConnectors.agentId],
    references: [agents.id],
  }),
}));

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
  skill: one(skills, {
    fields: [agentSkills.skillId],
    references: [skills.id],
  }),
  agent: one(agents, {
    fields: [agentSkills.agentId],
    references: [agents.id],
  }),
}));
