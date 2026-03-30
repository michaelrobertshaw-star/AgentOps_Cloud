-- M6.6: Deployment Flow
-- Add tested/deployed/disabled to agent_status enum + deployed_at/deployed_by_user_id columns

ALTER TYPE "agent_status" ADD VALUE IF NOT EXISTS 'tested';
ALTER TYPE "agent_status" ADD VALUE IF NOT EXISTS 'deployed';
ALTER TYPE "agent_status" ADD VALUE IF NOT EXISTS 'disabled';

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "deployed_at" timestamptz;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "deployed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_agents_deployed" ON "agents"("company_id") WHERE "status" = 'deployed';
