-- M6.1: Company Onboarding Wizard + M6.2: Skill File Builder
-- Adds: super_admin flag, company_settings table, skills table, agent_skills table

-- Super admin flag on users
ALTER TABLE "users" ADD COLUMN "super_admin" boolean NOT NULL DEFAULT false;

-- Company settings key/value store
CREATE TABLE "company_settings" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"  uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "key"         varchar(100) NOT NULL,
  "value"       jsonb NOT NULL DEFAULT 'null',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "idx_company_settings_company_key" ON "company_settings"("company_id", "key");
CREATE INDEX "idx_company_settings_company" ON "company_settings"("company_id");

-- Skills table (M6.2)
CREATE TABLE "skills" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"   uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name"         varchar(100) NOT NULL,
  "description"  text,
  "content"      jsonb NOT NULL DEFAULT '{}',
  "version"      integer NOT NULL DEFAULT 1,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "idx_skills_company_name" ON "skills"("company_id", "name");
CREATE INDEX "idx_skills_company" ON "skills"("company_id");

-- Agent ↔ Skill junction table (M6.2)
CREATE TABLE "agent_skills" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"  uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agent_id"    uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "skill_id"    uuid NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "idx_agent_skills_unique" ON "agent_skills"("agent_id", "skill_id");
CREATE INDEX "idx_agent_skills_agent" ON "agent_skills"("agent_id");
CREATE INDEX "idx_agent_skills_skill" ON "agent_skills"("skill_id");
CREATE INDEX "idx_agent_skills_company" ON "agent_skills"("company_id");
