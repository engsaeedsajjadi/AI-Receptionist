DO $$ BEGIN CREATE TYPE "tenant_role" AS ENUM ('OWNER','ADMIN','MANAGER','AGENT','VIEWER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "plan_code" AS ENUM ('FREE','STARTER','PROFESSIONAL','ENTERPRISE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "subscription_status" AS ENUM ('TRIALING','ACTIVE','PAST_DUE','CANCELED','PAUSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "invoice_status" AS ENUM ('DRAFT','OPEN','PAID','VOID','UNCOLLECTIBLE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tenants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(255) NOT NULL, slug varchar(100) NOT NULL UNIQUE,
 logo text, industry varchar(100) NOT NULL DEFAULT 'general', timezone varchar(50) NOT NULL DEFAULT 'Asia/Tehran',
 settings jsonb NOT NULL DEFAULT '{}'::jsonb, is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tenant_workspaces (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 business_id uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE, name varchar(255) NOT NULL,
 is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_workspaces_tenant_idx ON tenant_workspaces(tenant_id);
CREATE TABLE IF NOT EXISTS tenant_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, role tenant_role NOT NULL DEFAULT 'AGENT',
 is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,user_id)
);
CREATE INDEX IF NOT EXISTS tenant_users_user_idx ON tenant_users(user_id);
CREATE TABLE IF NOT EXISTS plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code plan_code NOT NULL UNIQUE, name varchar(100) NOT NULL,
 monthly_price numeric(12,2) NOT NULL DEFAULT 0, currency varchar(10) NOT NULL DEFAULT 'USD',
 voice_minutes integer NOT NULL DEFAULT 0, ai_tokens integer NOT NULL DEFAULT 0, storage_bytes numeric(20,0) NOT NULL DEFAULT 0,
 max_agents integer NOT NULL DEFAULT 1, max_users integer NOT NULL DEFAULT 1, features jsonb NOT NULL DEFAULT '{}'::jsonb,
 is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 plan_id uuid NOT NULL REFERENCES plans(id), status subscription_status NOT NULL DEFAULT 'ACTIVE', provider varchar(50) NOT NULL DEFAULT 'manual',
 provider_customer_id varchar(255), provider_subscription_id varchar(255), current_period_start timestamptz NOT NULL DEFAULT now(),
 current_period_end timestamptz, cancel_at_period_end boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_tenant_idx ON subscriptions(tenant_id,status);
CREATE TABLE IF NOT EXISTS invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL, number varchar(64) NOT NULL UNIQUE,
 status invoice_status NOT NULL DEFAULT 'DRAFT', amount_due numeric(12,2) NOT NULL DEFAULT 0, amount_paid numeric(12,2) NOT NULL DEFAULT 0,
 currency varchar(10) NOT NULL DEFAULT 'USD', issued_at timestamptz NOT NULL DEFAULT now(), due_at timestamptz, paid_at timestamptz,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS invoices_tenant_idx ON invoices(tenant_id,issued_at);
CREATE TABLE IF NOT EXISTS payment_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL, provider varchar(50) NOT NULL, provider_payment_id varchar(255),
 amount numeric(12,2) NOT NULL, currency varchar(10) NOT NULL DEFAULT 'USD', status varchar(30) NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_history_tenant_idx ON payment_history(tenant_id,created_at);
CREATE TABLE IF NOT EXISTS usage_meters (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 business_id uuid REFERENCES businesses(id) ON DELETE CASCADE, metric varchar(50) NOT NULL, quantity numeric(20,4) NOT NULL,
 unit varchar(30) NOT NULL, idempotency_key varchar(255), occurred_at timestamptz NOT NULL DEFAULT now(),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS usage_meters_tenant_metric_idx ON usage_meters(tenant_id,metric,occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS usage_meters_idempotency_idx ON usage_meters(tenant_id,idempotency_key);

INSERT INTO plans(code,name,monthly_price,voice_minutes,ai_tokens,storage_bytes,max_agents,max_users,features)
VALUES
 ('FREE','Free',0,60,100000,1073741824,1,2,'{"rag":true}'::jsonb),
 ('STARTER','Starter',29,500,1000000,10737418240,3,5,'{"rag":true,"voice":true}'::jsonb),
 ('PROFESSIONAL','Professional',99,3000,5000000,53687091200,10,20,'{"rag":true,"voice":true,"crm":true,"analytics":true}'::jsonb),
 ('ENTERPRISE','Enterprise',299,15000,25000000,536870912000,100,250,'{"rag":true,"voice":true,"crm":true,"analytics":true,"sso":true,"audit":true}'::jsonb)
ON CONFLICT(code) DO NOTHING;

-- Backfill one tenant per existing business without changing existing API contracts.
INSERT INTO tenants(name,slug,industry,timezone,settings,created_at,updated_at)
SELECT b.name,b.slug,b.industry,b.timezone,b.settings,b.created_at,b.updated_at FROM businesses b
ON CONFLICT(slug) DO NOTHING;
INSERT INTO tenant_workspaces(tenant_id,business_id,name,is_default)
SELECT t.id,b.id,b.name,true FROM businesses b JOIN tenants t ON t.slug=b.slug
ON CONFLICT(business_id) DO NOTHING;
INSERT INTO tenant_users(tenant_id,user_id,role)
SELECT tw.tenant_id,u.id,CASE u.role::text WHEN 'ADMIN' THEN 'OWNER'::tenant_role WHEN 'MANAGER' THEN 'MANAGER'::tenant_role ELSE 'AGENT'::tenant_role END
FROM users u JOIN tenant_workspaces tw ON tw.business_id=u.business_id
ON CONFLICT(tenant_id,user_id) DO NOTHING;
INSERT INTO subscriptions(tenant_id,plan_id,status,provider)
SELECT t.id,p.id,'ACTIVE','manual' FROM tenants t CROSS JOIN plans p WHERE p.code='FREE'
AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id=t.id);
