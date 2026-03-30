-- M6.4: Agent Execution Engine
-- Adds browser_sessions table for computer-use (browser connector) runs

CREATE TABLE "browser_sessions" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_run_id"  uuid NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "screenshots"   jsonb NOT NULL DEFAULT '[]',
  "actions"       jsonb NOT NULL DEFAULT '[]',
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_browser_sessions_run" ON "browser_sessions"("agent_run_id");
