ALTER TABLE "agent_api_keys" ADD COLUMN "valid_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "idx_agent_keys_valid_until" ON "agent_api_keys" USING btree ("valid_until");
