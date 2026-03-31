export type CompanyStatus = "active" | "suspended" | "deactivated";

export type UserStatus = "active" | "invited" | "deactivated";

export type UserRole = "oneops_admin" | "customer_admin" | "customer_user";

export type DepartmentStatus = "active" | "archived";

export type DepartmentRole = "department_manager" | "operator" | "viewer";

export type AgentStatus =
  | "draft"
  | "testing"
  | "tested"
  | "active"
  | "degraded"
  | "paused"
  | "stopped"
  | "error"
  | "archived"
  | "deployed"
  | "disabled";

export type ApiKeyStatus = "active" | "revoked" | "expired";

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "retrying"
  | "escalated"
  | "cancelled";

export type TaskPriority = "critical" | "high" | "medium" | "low";

export type TaskRunStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out";

export type WorkspaceStatus = "active" | "archived" | "deleted";

export type IncidentSeverity = "critical" | "high" | "medium" | "low";

export type IncidentStatus = "open" | "investigating" | "mitigated" | "resolved" | "closed";

export type AuditActorType = "user" | "agent" | "system";

export type AuditOutcome = "success" | "failure" | "denied";

export type AuditRiskLevel = "critical" | "high" | "medium" | "low";

export type WebhookStatus = "active" | "paused" | "failed";

export type ConnectorType =
  | "claude_api"
  | "claude_browser"
  | "webhook"
  | "http_get"
  | "minio_storage";

// Permission types from ONE-3 security architecture
export type Permission =
  | "company:manage"
  | "company:view"
  | "department:create"
  | "department:manage"
  | "department:view"
  | "department:intervene"
  | "agent:create"
  | "agent:manage"
  | "agent:view"
  | "task:create"
  | "task:view"
  | "task:retry"
  | "task:cancel"
  | "workspace:view"
  | "workspace:export"
  | "workspace:write"
  | "incident:create"
  | "incident:view"
  | "incident:manage"
  | "audit:view"
  | "audit:manage"
  | "apikey:manage"
  | "user:manage"
  | "user:invite_dept"
  | "connector:manage"
  | "connector:view";

// Role → permission mapping (from ONE-3 permission matrix)
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  oneops_admin: [
    "company:manage",
    "company:view",
    "department:create",
    "department:manage",
    "department:view",
    "department:intervene",
    "agent:create",
    "agent:manage",
    "agent:view",
    "task:create",
    "task:view",
    "task:retry",
    "task:cancel",
    "workspace:view",
    "workspace:export",
    "workspace:write",
    "incident:create",
    "incident:view",
    "incident:manage",
    "audit:view",
    "audit:manage",
    "apikey:manage",
    "user:manage",
    "user:invite_dept",
    "connector:manage",
    "connector:view",
  ],
  customer_admin: [
    "company:view",
    "department:view",
    "department:intervene",
    "agent:create",
    "agent:manage",
    "agent:view",
    "task:create",
    "task:view",
    "task:retry",
    "task:cancel",
    "workspace:view",
    "workspace:export",
    "workspace:write",
    "incident:create",
    "incident:view",
    "incident:manage",
    "apikey:manage",
    "connector:manage",
    "connector:view",
  ],
  customer_user: [
    "company:view",
    "department:view",
    "agent:view",
    "task:view",
    "workspace:view",
    "workspace:export",
    "incident:view",
    "audit:view",
    "connector:view",
  ],
};

export const DEPARTMENT_ROLE_PERMISSIONS: Record<DepartmentRole, Permission[]> = {
  department_manager: [
    "department:manage",
    "department:view",
    "department:intervene",
    "agent:create",
    "agent:manage",
    "agent:view",
    "task:create",
    "task:view",
    "task:retry",
    "task:cancel",
    "workspace:view",
    "workspace:export",
    "workspace:write",
    "incident:create",
    "incident:view",
    "incident:manage",
    "apikey:manage",
    "user:invite_dept",
  ],
  operator: [
    "department:view",
    "agent:view",
    "task:create",
    "task:view",
    "task:retry",
    "task:cancel",
    "workspace:view",
    "workspace:write",
    "incident:create",
    "incident:view",
  ],
  viewer: [
    "department:view",
    "agent:view",
    "task:view",
    "workspace:view",
    "incident:view",
  ],
};

// JWT token payload types
export interface JwtPayload {
  sub: string; // "user:<user_id>"
  company_id: string;
  roles: UserRole[];
  department_roles: Record<string, DepartmentRole>;
  super_admin?: boolean;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface RefreshTokenPayload {
  sub: string;
  company_id: string;
  token_id: string;
  iat: number;
  exp: number;
  iss: string;
}
