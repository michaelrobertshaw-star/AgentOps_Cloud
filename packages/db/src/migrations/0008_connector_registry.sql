-- M6.3: Connector Registry
-- Adds connectors, agent_connectors tables and agentRuns/agentRunStatus (pre-declared for M6.4)

-- Connector type enum
CREATE TYPE "connector_type" AS ENUM (
  'claude_api',
  'claude_browser',
  'webhook',
  'http_get',
  'minio_storage'
);

-- Connectors table
CREATE TABLE "connectors" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"          uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "type"                "connector_type" NOT NULL,
  "name"                varchar(100) NOT NULL,
  "description"         text,
  "config"              jsonb NOT NULL DEFAULT '{}',
  "secrets_encrypted"   jsonb,
  "is_default"          boolean NOT NULL DEFAULT false,
  "created_by_user_id"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "idx_connectors_company_name" ON "connectors"("company_id", "name");
CREATE INDEX "idx_connectors_company" ON "connectors"("company_id");
CREATE INDEX "idx_connectors_type" ON "connectors"("company_id", "type");

-- Agent ↔ Connector join table
CREATE TABLE "agent_connectors" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"    uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agent_id"      uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "connector_id"  uuid NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
  "created_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "idx_agent_connectors_unique" ON "agent_connectors"("agent_id", "connector_id");
CREATE INDEX "idx_agent_connectors_agent" ON "agent_connectors"("agent_id");
CREATE INDEX "idx_agent_connectors_connector" ON "agent_connectors"("connector_id");
CREATE INDEX "idx_agent_connectors_company" ON "agent_connectors"("company_id");

-- Agent run status enum (M6.4 pre-declaration)
CREATE TYPE "agent_run_status" AS ENUM (
  'running',
  'completed',
  'failed',
  'timed_out',
  'cancelled'
);

-- Agent runs table (schema declared here, execution logic in M6.4)
CREATE TABLE "agent_runs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"      uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agent_id"        uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "task_id"         uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "status"          "agent_run_status" NOT NULL DEFAULT 'running',
  "input"           jsonb,
  "output"          text,
  "model"           varchar(100),
  "tokens_input"    integer NOT NULL DEFAULT 0,
  "tokens_output"   integer NOT NULL DEFAULT 0,
  "cost_usd"        decimal(12, 6),
  "duration_ms"     integer,
  "error"           text,
  "started_at"      timestamptz NOT NULL DEFAULT now(),
  "completed_at"    timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_agent_runs_agent" ON "agent_runs"("agent_id");
CREATE INDEX "idx_agent_runs_company_time" ON "agent_runs"("company_id", "created_at");
CREATE INDEX "idx_agent_runs_status" ON "agent_runs"("company_id", "status");
