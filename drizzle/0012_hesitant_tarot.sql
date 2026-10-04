CREATE TABLE "billing_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"plan" varchar(20) NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"customer_name" varchar(255) NOT NULL,
	"issuer" text NOT NULL,
	"payment_instructions" text NOT NULL,
	"payment_reference" varchar(255),
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"plan" varchar(20) DEFAULT 'FREE' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_invoices_tenant_key" ON "billing_invoices" USING btree ("business_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_invoices_payment_reference" ON "billing_invoices" USING btree ("payment_reference");--> statement-breakpoint
CREATE INDEX "billing_invoices_tenant_created" ON "billing_invoices" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_business_unique" ON "subscriptions" USING btree ("business_id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_check" CHECK ("plan" IN ('FREE','STARTER','BUSINESS','ENTERPRISE'));
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_period_check" CHECK (("plan" = 'FREE' AND "period_start" IS NULL AND "period_end" IS NULL) OR ("plan" <> 'FREE' AND "period_start" IS NOT NULL AND "period_end" IS NOT NULL AND "period_end" > "period_start"));
--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoice_values_check" CHECK ("plan" IN ('STARTER','BUSINESS','ENTERPRISE') AND "amount_minor" > 0 AND "currency" IN ('USD','EUR','GBP','IRR') AND "status" IN ('open','paid','void'));
--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoice_payment_check" CHECK (("status" = 'paid' AND "paid_at" IS NOT NULL AND "payment_reference" IS NOT NULL) OR ("status" <> 'paid' AND "paid_at" IS NULL AND "payment_reference" IS NULL));
