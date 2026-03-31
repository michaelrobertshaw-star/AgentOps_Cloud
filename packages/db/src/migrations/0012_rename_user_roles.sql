-- Rename user_role enum values: company_admin→oneops_admin, technical_admin→customer_admin, auditor→customer_user
ALTER TYPE "public"."user_role" RENAME VALUE 'company_admin' TO 'oneops_admin';--> statement-breakpoint
ALTER TYPE "public"."user_role" RENAME VALUE 'technical_admin' TO 'customer_admin';--> statement-breakpoint
ALTER TYPE "public"."user_role" RENAME VALUE 'auditor' TO 'customer_user';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'customer_user';
