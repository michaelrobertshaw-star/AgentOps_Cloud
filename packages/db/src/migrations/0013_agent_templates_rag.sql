-- Migration 0013: Agent Templates + RAG Knowledge Store
-- Adds agent_templates table, knowledge_chunks table, and extends connector_type enum

-- Enable pgvector extension (safe to run if already enabled)
CREATE EXTENSION IF NOT EXISTS vector;

-- Extend connector_type enum with infrastructure and data layer types
-- Note: ALTER TYPE ADD VALUE cannot be run in a transaction in older Postgres
-- Using DO blocks for safety
DO $$ BEGIN
  ALTER TYPE connector_type ADD VALUE IF NOT EXISTS 'aws_bedrock';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TYPE connector_type ADD VALUE IF NOT EXISTS 'gcp_vertex';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TYPE connector_type ADD VALUE IF NOT EXISTS 'replicate';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TYPE connector_type ADD VALUE IF NOT EXISTS 'modal';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TYPE connector_type ADD VALUE IF NOT EXISTS 'postgres_db';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TYPE connector_type ADD VALUE IF NOT EXISTS 'rest_api';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TYPE connector_type ADD VALUE IF NOT EXISTS 'vector_db';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TYPE connector_type ADD VALUE IF NOT EXISTS 'pdf_docs';
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Agent Templates catalogue (browsable, filterable, multi-tenant)
CREATE TABLE IF NOT EXISTS agent_templates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID REFERENCES companies(id) ON DELETE CASCADE,
  slug                 VARCHAR(100) NOT NULL UNIQUE,
  name                 VARCHAR(200) NOT NULL,
  description          TEXT,
  tier                 VARCHAR(20) NOT NULL DEFAULT 'simple',
  layer_config         JSONB NOT NULL DEFAULT '{}',
  default_agent_config JSONB NOT NULL DEFAULT '{}',
  is_built_in          BOOLEAN NOT NULL DEFAULT FALSE,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  use_count            INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_at_tier     ON agent_templates(tier);
CREATE INDEX IF NOT EXISTS idx_at_company  ON agent_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_at_builtin  ON agent_templates(is_built_in);
CREATE INDEX IF NOT EXISTS idx_at_slug     ON agent_templates(slug);

-- Knowledge chunks for RAG (vector similarity search)
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   JSONB,           -- stores number[] for full-text fallback
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kc_agent   ON knowledge_chunks(agent_id);
CREATE INDEX IF NOT EXISTS idx_kc_company ON knowledge_chunks(company_id);

-- Add real vector column if pgvector is available (idempotent)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    BEGIN
      ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_vec VECTOR(1536);
      CREATE INDEX IF NOT EXISTS idx_kc_embed ON knowledge_chunks
        USING hnsw (embedding_vec vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Vector column/index setup note: %', SQLERRM;
    END;
  END IF;
END $$;

-- Add tsvector column for full-text fallback
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
CREATE INDEX IF NOT EXISTS idx_kc_fts ON knowledge_chunks USING GIN(search_vector);

-- Trigger to keep search_vector updated
CREATE OR REPLACE FUNCTION knowledge_chunks_search_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS knowledge_chunks_search_trigger ON knowledge_chunks;
CREATE TRIGGER knowledge_chunks_search_trigger
  BEFORE INSERT OR UPDATE ON knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION knowledge_chunks_search_update();
