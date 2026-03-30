-- Add audit retention policy to companies
ALTER TABLE "companies" ADD COLUMN "audit_retention_days" integer NOT NULL DEFAULT 90;

-- Add prev_hash to audit_logs to enable proper cryptographic chain verification
ALTER TABLE "audit_logs" ADD COLUMN "prev_hash" varchar(64);

CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" USING btree ("company_id", "created_at");
