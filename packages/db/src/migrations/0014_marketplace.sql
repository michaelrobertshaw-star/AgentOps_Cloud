-- Phase 4d: Template Marketplace
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'private';
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS published_by_company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS install_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS template_installs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES agent_templates(id) ON DELETE CASCADE,
  installed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_template_installs_unique ON template_installs(company_id, template_id);
CREATE INDEX IF NOT EXISTS idx_template_installs_company ON template_installs(company_id);
CREATE INDEX IF NOT EXISTS idx_template_installs_template ON template_installs(template_id);

-- MCP server connector type (Phase 4c)
DO $$ BEGIN
  ALTER TYPE connector_type ADD VALUE IF NOT EXISTS 'mcp_server';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
