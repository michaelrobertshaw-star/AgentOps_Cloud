CREATE TABLE "incident_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "incident_id" uuid NOT NULL REFERENCES "incidents"("id") ON DELETE CASCADE,
  "workspace_file_id" uuid NOT NULL REFERENCES "workspace_files"("id") ON DELETE CASCADE,
  "attached_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE("incident_id", "workspace_file_id")
);
--> statement-breakpoint
CREATE INDEX "idx_incident_attachments_incident" ON "incident_attachments"("incident_id");
