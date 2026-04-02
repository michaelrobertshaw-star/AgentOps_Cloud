-- Add structured logs column to agent_runs
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "logs" jsonb DEFAULT '[]';
