import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { businesses, users } from "@/db/schema";

export const tenantRoleEnum = pgEnum("tenant_role", ["OWNER", "ADMIN", "MANAGER", "AGENT", "VIEWER"]);
export const planCodeEnum = pgEnum("plan_code", ["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELED", "PAUSED"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["DRAFT", "OPEN", "PAID", "VOID", "UNCOLLECTIBLE"]);

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),
  logo: text("logo"),
  industry: varchar("industry", { length: 100 }).notNull().default("general"),
  timezone: varchar("timezone", { length: 50 }).notNull().default("Asia/Tehran"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ slugIdx: uniqueIndex("tenants_slug_idx").on(t.slug) }));

export const tenantWorkspaces = pgTable("tenant_workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  businessIdx: uniqueIndex("tenant_workspaces_business_idx").on(t.businessId),
  tenantIdx: index("tenant_workspaces_tenant_idx").on(t.tenantId),
}));

export const tenantUsers = pgTable("tenant_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: tenantRoleEnum("role").notNull().default("AGENT"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  membershipIdx: uniqueIndex("tenant_users_membership_idx").on(t.tenantId, t.userId),
  userIdx: index("tenant_users_user_idx").on(t.userId),
}));

export const plans = pgTable("plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: planCodeEnum("code").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  monthlyPrice: numeric("monthly_price", { precision: 12, scale: 2 }).notNull().default("0"),
  currency: varchar("currency", { length: 10 }).notNull().default("USD"),
  voiceMinutes: integer("voice_minutes").notNull().default(0),
  aiTokens: integer("ai_tokens").notNull().default(0),
  storageBytes: numeric("storage_bytes", { precision: 20, scale: 0 }).notNull().default("0"),
  maxAgents: integer("max_agents").notNull().default(1),
  maxUsers: integer("max_users").notNull().default(1),
  features: jsonb("features").$type<Record<string, boolean>>().notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ codeIdx: uniqueIndex("plans_code_idx").on(t.code) }));

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").notNull().references(() => plans.id),
  status: subscriptionStatusEnum("status").notNull().default("ACTIVE"),
  provider: varchar("provider", { length: 50 }).notNull().default("manual"),
  providerCustomerId: varchar("provider_customer_id", { length: 255 }),
  providerSubscriptionId: varchar("provider_subscription_id", { length: 255 }),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull().defaultNow(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ tenantIdx: index("subscriptions_tenant_idx").on(t.tenantId, t.status) }));

export const invoices = pgTable("invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
  number: varchar("number", { length: 64 }).notNull(),
  status: invoiceStatusEnum("status").notNull().default("DRAFT"),
  amountDue: numeric("amount_due", { precision: 12, scale: 2 }).notNull().default("0"),
  amountPaid: numeric("amount_paid", { precision: 12, scale: 2 }).notNull().default("0"),
  currency: varchar("currency", { length: 10 }).notNull().default("USD"),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (t) => ({
  numberIdx: uniqueIndex("invoices_number_idx").on(t.number),
  tenantIdx: index("invoices_tenant_idx").on(t.tenantId, t.issuedAt),
}));

export const paymentHistory = pgTable("payment_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  provider: varchar("provider", { length: 50 }).notNull(),
  providerPaymentId: varchar("provider_payment_id", { length: 255 }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 10 }).notNull().default("USD"),
  status: varchar("status", { length: 30 }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ tenantIdx: index("payment_history_tenant_idx").on(t.tenantId, t.createdAt) }));

export const usageMeters = pgTable("usage_meters", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
  metric: varchar("metric", { length: 50 }).notNull(),
  quantity: numeric("quantity", { precision: 20, scale: 4 }).notNull(),
  unit: varchar("unit", { length: 30 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (t) => ({
  tenantMetricIdx: index("usage_meters_tenant_metric_idx").on(t.tenantId, t.metric, t.occurredAt),
  idempotencyIdx: uniqueIndex("usage_meters_idempotency_idx").on(t.tenantId, t.idempotencyKey),
}));
