CREATE TABLE "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "webhook_id" uuid NOT NULL REFERENCES "webhooks"("id") ON DELETE CASCADE,
  "event_type" varchar(100) NOT NULL,
  "payload" jsonb NOT NULL,
  "status_code" integer,
  "response_body" text,
  "attempt_number" integer DEFAULT 1 NOT NULL,
  "success" boolean NOT NULL,
  "error_message" text,
  "duration_ms" integer,
  "delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_webhook" ON "webhook_deliveries"("webhook_id");
--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_company_time" ON "webhook_deliveries"("company_id", "delivered_at");
