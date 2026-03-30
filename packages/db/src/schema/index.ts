import { pgTable, uuid, varchar, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const agentStatusEnum = pgEnum("agent_status", [
  "draft",
  "testing",
  "active",
  "degraded",
  "paused",
  "stopped",
  "error",
  "archived",
]);

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

export const incidentSeverityEnum = pgEnum("incident_severity", [
  "critical",
  "high",
  "medium",
  "low",
]);

export const companies = pgTable("companies", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  displayName: varchar("display_name", { length: 255 }),
  status: varchar("status", { length: 50 }).default("active").notNull(),
  timezone: varchar("timezone", { length: 100 }).default("UTC"),
  region: varchar("region", { length: 50 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .references(() => companies.id)
    .notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 50 }).notNull(),
  status: varchar("status", { length: 50 }).default("active").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const departments = pgTable("departments", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .references(() => companies.id)
    .notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 50 }).default("active").notNull(),
  managerUserId: uuid("manager_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .references(() => companies.id)
    .notNull(),
  departmentId: uuid("department_id").references(() => departments.id),
  name: varchar("name", { length: 255 }).notNull(),
  type: varchar("type", { length: 100 }),
  version: varchar("version", { length: 50 }),
  status: agentStatusEnum("status").default("draft").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .references(() => companies.id)
    .notNull(),
  departmentId: uuid("department_id").references(() => departments.id),
  agentId: uuid("agent_id").references(() => agents.id),
  status: taskStatusEnum("status").default("pending").notNull(),
  priority: varchar("priority", { length: 20 }).default("medium"),
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const incidents = pgTable("incidents", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .references(() => companies.id)
    .notNull(),
  departmentId: uuid("department_id").references(() => departments.id),
  taskId: uuid("task_id").references(() => tasks.id),
  severity: incidentSeverityEnum("severity").notNull(),
  description: text("description").notNull(),
  status: varchar("status", { length: 50 }).default("open").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
