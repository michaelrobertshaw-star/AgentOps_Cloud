export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "retrying"
  | "escalated"
  | "cancelled";

export type AgentStatus =
  | "draft"
  | "testing"
  | "active"
  | "degraded"
  | "paused"
  | "stopped"
  | "error"
  | "archived";

export type IncidentSeverity = "critical" | "high" | "medium" | "low";

export type UserRole = "company_admin" | "technical_admin" | "auditor";

export type DepartmentRole = "department_manager" | "operator" | "viewer";
