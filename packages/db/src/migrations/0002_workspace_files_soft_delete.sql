-- M3.2: Add soft-delete support to workspace_files
ALTER TABLE "workspace_files" ADD COLUMN "deleted_at" timestamp with time zone;
