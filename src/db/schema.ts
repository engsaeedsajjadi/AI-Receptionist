import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", ["ADMIN", "MANAGER", "AGENT", "SUPER_ADMIN", "TENANT_ADMIN", "AGENT_OPERATOR", "CALL_OPERATOR", "VIEWER"]);
export const leadStatusEnum = pgEnum("lead_status", [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "VISIT_REQUESTED",
  "VISIT_SCHEDULED",
  "NEGOTIATION",
  "WON",
  "LOST",
]);
export const leadTypeEnum = pgEnum("lead_type", ["BUY", "RENT", "SELL", "OTHER"]);
export const callDirectionEnum = pgEnum("call_direction", ["INBOUND", "OUTBOUND"]);
export const callStatusEnum = pgEnum("call_status", [
  "RINGING",
  "CONNECTED",
  "IN_PROGRESS",
  "ANSWERED",
  "TRANSFER_REQUESTED",
  "TRANSFERRING",
  "TRANSFERRED",
  "TRANSFER_FAILED",
  "COMPLETED",
  "MISSED",
  "FAILED",
]);
export const callMessageRoleEnum = pgEnum("call_message_role", ["CUSTOMER", "AGENT", "SYSTEM", "TOOL"]);
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "REQUESTED",
  "SCHEDULED",
  "CANCELLED",
  "COMPLETED",
]);
export const notificationStatusEnum = pgEnum("notification_status", ["PENDING", "SENT", "FAILED"]);

export const outboxStatusEnum = pgEnum("outbox_status", ["pending", "processing", "delivered", "dead"]);
export const businessLifecycleEnum = pgEnum("business_lifecycle", ["ACTIVE", "SUSPENDED", "PENDING_DELETION", "DELETED"]);
export const knowledgeStatusEnum = pgEnum("knowledge_status", ["DRAFT", "PROCESSING", "ACTIVE", "ARCHIVED", "FAILED"]);
export const knowledgeVisibilityEnum = pgEnum("knowledge_visibility", ["TENANT", "ROLE", "AGENT", "CATEGORY", "PRIVATE"]);
export const paymentAttemptStatusEnum = pgEnum("payment_attempt_status", [
  "PENDING", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELED",
]);
export const paymentTransactionKindEnum = pgEnum("payment_transaction_kind", ["CHARGE", "REFUND", "CREDIT"]);
export const refundStatusEnum = pgEnum("refund_status", ["REQUESTED", "SUCCEEDED", "FAILED", "PARTIAL"]);
export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", ["pending", "delivered", "failed", "dead"]);


// ---------------------------------------------------------------------------
// Businesses / users / agents
// ---------------------------------------------------------------------------

export const businesses = pgTable(
  "businesses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    industry: varchar("industry", { length: 100 }).notNull().default("real_estate"),
    phone: varchar("phone", { length: 30 }),
    address: text("address"),
    timezone: varchar("timezone", { length: 50 }).notNull().default("Asia/Tehran"),
    language: varchar("language", { length: 10 }).notNull().default("fa"),
    isActive: boolean("is_active").notNull().default(true),
    status: businessLifecycleEnum("status").notNull().default("ACTIVE"),
    customDomain: varchar("custom_domain", { length: 253 }),
    deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
    deletionScheduledFor: timestamp("deletion_scheduled_for", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({
      recording_enabled: true,
      transcription_enabled: true,
      retention_days: 90,
      disclosure_message: "این تماس ممکن است برای بهبود خدمات ضبط شود.",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugIdx: uniqueIndex("businesses_slug_idx").on(table.slug),
    customDomainIdx: uniqueIndex("businesses_custom_domain_idx").on(table.customDomain),
    // One phone number belongs to exactly one tenant: an inbound call must never
    // be routed ambiguously. Partial, because many tenants have no number yet.
    phoneIdx: uniqueIndex("businesses_phone_idx").on(table.phone).where(sql`${table.phone} is not null`),
  }),
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 150 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 30 }),
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    mfaSecret: text("mfa_secret"),
    credentialVersion: integer("credential_version").notNull().default(0),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaLastStep: integer("mfa_last_step").notNull().default(-1),
    mfaRecoveryHashes: jsonb("mfa_recovery_hashes").$type<string[]>().notNull().default([]),
    role: userRoleEnum("role").notNull().default("AGENT"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    invitedById: uuid("invited_by_id").references((): any => users.id, { onDelete: "set null" }),
    locale: varchar("locale", { length: 10 }).notNull().default("fa"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: uniqueIndex("users_email_idx").on(table.email),
    businessIdx: index("users_business_idx").on(table.businessId),
    businessRoleIdx: index("users_business_role_idx").on(table.businessId, table.role),
  }),
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 150 }).notNull(),
    systemPrompt: text("system_prompt").notNull().default(""),
    voiceProvider: varchar("voice_provider", { length: 100 }).notNull().default("generic"),
    voiceId: varchar("voice_id", { length: 100 }).notNull().default("fa-default"),
    language: varchar("language", { length: 20 }).notNull().default("fa-IR"),
    isActive: boolean("is_active").notNull().default(true),
    configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdIdx: uniqueIndex("agents_tenant_id_idx").on(table.id, table.businessId),
    businessIdx: index("agents_business_idx").on(table.businessId),
    businessActiveIdx: index("agents_business_active_idx").on(table.businessId, table.isActive),
  }),
);

// ---------------------------------------------------------------------------
// CRM: customers / leads / notes
// ---------------------------------------------------------------------------

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull().default(""),
    phone: varchar("phone", { length: 30 }).notNull(),
    email: varchar("email", { length: 255 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    businessPhoneIdx: uniqueIndex("customers_business_phone_idx").on(table.businessId, table.phone),
    businessCreatedIdx: index("customers_business_created_idx").on(table.businessId, table.createdAt),
  }),
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    source: varchar("source", { length: 50 }).notNull().default("call"),
    type: leadTypeEnum("type").notNull().default("OTHER"),
    status: leadStatusEnum("status").notNull().default("NEW"),
    score: integer("score").notNull().default(0),
    /** Explainable rationale for `score` (rubric version + itemised factors). */
    scoreRationale: jsonb("score_rationale").$type<Record<string, unknown>>().notNull().default({}),
    budgetMin: numeric("budget_min"),
    budgetMax: numeric("budget_max"),
    location: text("location"),
    minArea: numeric("min_area"),
    maxArea: numeric("max_area"),
    bedrooms: integer("bedrooms"),
    timeframe: varchar("timeframe", { length: 50 }),
    requestedVisit: boolean("requested_visit").notNull().default(false),
    summary: text("summary"),
    notes: text("notes"),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdIdx: uniqueIndex("leads_tenant_id_idx").on(table.id, table.businessId),
    businessStatusIdx: index("leads_business_status_idx").on(table.businessId, table.status),
    businessCreatedIdx: index("leads_business_created_idx").on(table.businessId, table.createdAt),
    businessCustomerIdx: index("leads_business_customer_idx").on(table.businessId, table.customerId),
    businessAssigneeIdx: index("leads_business_assignee_idx").on(table.businessId, table.assignedUserId),
  }),
);

export const leadNotes = pgTable(
  "lead_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    leadCreatedIdx: index("lead_notes_lead_created_idx").on(table.leadId, table.createdAt),
    businessIdx: index("lead_notes_business_idx").on(table.businessId),
    leadTenantFk: foreignKey({
      name: "lead_notes_lead_tenant_fk",
      columns: [table.leadId, table.businessId],
      foreignColumns: [leads.id, leads.businessId],
    }).onDelete("cascade"),
  }),
);

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const calls = pgTable(
  "calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    externalCallId: varchar("external_call_id", { length: 255 }),
    direction: callDirectionEnum("direction").notNull().default("INBOUND"),
    phoneNumber: varchar("phone_number", { length: 30 }).notNull(),
    status: callStatusEnum("status").notNull().default("RINGING"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    recordingUrl: text("recording_url"),
    transcript: text("transcript"),
    summary: text("summary"),
    transferTo: varchar("transfer_to", { length: 30 }),
    transferRequestedAt: timestamp("transfer_requested_at", { withTimezone: true }),
    transferCompletedAt: timestamp("transfer_completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdIdx: uniqueIndex("calls_tenant_id_idx").on(table.id, table.businessId),
    businessExternalIdx: uniqueIndex("calls_business_external_idx").on(table.businessId, table.externalCallId),
    businessStatusIdx: index("calls_business_status_idx").on(table.businessId, table.status),
    businessCreatedIdx: index("calls_business_created_idx").on(table.businessId, table.createdAt),
    businessPhoneIdx: index("calls_business_phone_idx").on(table.businessId, table.phoneNumber),
  }),
);

export const callMessages = pgTable(
  "call_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    role: callMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    // Provider-supplied segment identity for idempotent transcript ingestion.
    // NULL for internally generated messages (agent turns); the unique index
    // only constrains non-null provider event ids (Postgres treats NULLs as
    // distinct in unique indexes).
    eventId: varchar("event_id", { length: 255 }),
    seq: integer("seq"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    callTimeIdx: index("call_messages_call_time_idx").on(table.callId, table.timestamp),
    callEventIdx: uniqueIndex("call_messages_call_event_idx").on(table.callId, table.eventId),
    callTenantFk: foreignKey({
      name: "call_messages_call_tenant_fk",
      columns: [table.callId, table.businessId],
      foreignColumns: [calls.id, calls.businessId],
    }).onDelete("cascade"),
  }),
);

// ---------------------------------------------------------------------------
// Knowledge base (RAG)
// ---------------------------------------------------------------------------

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    sourceType: varchar("source_type", { length: 50 }).notNull().default("manual"),
    sourceUrl: text("source_url"),
    fileName: varchar("file_name", { length: 255 }),
    mimeType: varchar("mime_type", { length: 100 }),
    fileSize: integer("file_size"),
    storageKey: text("storage_key"),
    status: varchar("status", { length: 20 }).notNull().default("indexed"),
    lifecycle: knowledgeStatusEnum("lifecycle").notNull().default("ACTIVE"),
    version: integer("version").notNull().default(1),
    supersedesDocumentId: uuid("supersedes_document_id"),
    visibility: knowledgeVisibilityEnum("visibility").notNull().default("TENANT"),
    acl: jsonb("acl").$type<Record<string, unknown>>().notNull().default({}),
    language: varchar("language", { length: 10 }).notNull().default("fa"),
    documentType: varchar("document_type", { length: 60 }),
    category: varchar("category", { length: 80 }),
    product: varchar("product", { length: 120 }),
    service: varchar("service", { length: 120 }),
    branch: varchar("branch", { length: 120 }),
    department: varchar("department", { length: 120 }),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    chunkCount: integer("chunk_count").notNull().default(0),
    errorMessage: text("error_message"),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    businessStatusIdx: index("knowledge_documents_business_status_idx").on(table.businessId, table.status),
    businessCreatedIdx: index("knowledge_documents_business_created_idx").on(table.businessId, table.createdAt),
    tenantIdIdx: uniqueIndex("knowledge_documents_tenant_id_idx").on(table.id, table.businessId),
    versionIdx: index("knowledge_documents_version_idx").on(table.businessId, table.title, table.version),
    lifecycleIdx: index("knowledge_documents_lifecycle_idx").on(table.businessId, table.lifecycle),
    supersedesIdx: index("knowledge_documents_supersedes_idx").on(table.businessId, table.supersedesDocumentId),
  }),
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull().default(0),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    tokenCount: integer("token_count"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    businessIdx: index("knowledge_chunks_business_idx").on(table.businessId),
    documentIdx: index("knowledge_chunks_document_idx").on(table.documentId, table.chunkIndex),
    // Composite tenant FK: a chunk can never point at another tenant's document.
    documentTenantFk: foreignKey({
      name: "knowledge_chunks_document_tenant_fk",
      columns: [table.documentId, table.businessId],
      foreignColumns: [knowledgeDocuments.id, knowledgeDocuments.businessId],
    }).onDelete("cascade"),
  }),
);

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    title: varchar("title", { length: 255 }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    status: appointmentStatusEnum("status").notNull().default("REQUESTED"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    businessScheduledIdx: index("appointments_business_scheduled_idx").on(table.businessId, table.scheduledAt),
    businessStatusIdx: index("appointments_business_status_idx").on(table.businessId, table.status),
    businessAssigneeIdx: index("appointments_business_assignee_idx").on(table.businessId, table.assignedUserId),
  }),
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    type: varchar("type", { length: 50 }).notNull(),
    channel: varchar("channel", { length: 20 }).notNull().default("internal"),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message").notNull(),
    status: notificationStatusEnum("status").notNull().default("PENDING"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    recipient: varchar("recipient", { length: 255 }),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    businessCreatedIdx: index("notifications_business_created_idx").on(table.businessId, table.createdAt),
    businessUserIdx: index("notifications_business_user_idx").on(table.businessId, table.userId),
    businessIdemIdx: uniqueIndex("notifications_business_idem_idx").on(table.businessId, table.idempotencyKey),
  }),
);

// ---------------------------------------------------------------------------
// Automation dispatches (n8n fan-out dedup — the app-side critical store)
// ---------------------------------------------------------------------------

export const automationDispatches = pgTable(
  "automation_dispatches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    event: varchar("event", { length: 50 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    channel: varchar("channel", { length: 20 }).notNull(),
    recipient: varchar("recipient", { length: 255 }).notNull(),
    title: varchar("title", { length: 255 }).notNull().default(""),
    message: text("message").notNull(),
    status: notificationStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    errorMessage: text("error_message"),
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    businessCreatedIdx: index("automation_dispatches_business_created_idx").on(
      table.businessId,
      table.createdAt,
    ),
    businessIdemIdx: uniqueIndex("automation_dispatches_business_idem_idx").on(
      table.businessId,
      table.idempotencyKey,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Usage / cost tracking
// ---------------------------------------------------------------------------

export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 50 }).notNull(),
    quantity: numeric("quantity").notNull(),
    unit: varchar("unit", { length: 30 }).notNull(),
    provider: varchar("provider", { length: 50 }),
    estimatedCost: numeric("estimated_cost"),
    currency: varchar("currency", { length: 10 }).notNull().default("USD"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    businessTypeIdx: index("usage_business_type_idx").on(table.businessId, table.type),
    businessCreatedIdx: index("usage_business_created_idx").on(table.businessId, table.createdAt),
    businessIdemIdx: uniqueIndex("usage_business_idem_idx").on(table.businessId, table.idempotencyKey),
  }),
);

// ---------------------------------------------------------------------------
// Auth: refresh tokens (rotation + reuse detection)
// ---------------------------------------------------------------------------

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    jti: varchar("jti", { length: 64 }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: varchar("revoked_reason", { length: 50 }),
    rotatedFromId: uuid("rotated_from_id"),
    userAgent: varchar("user_agent", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index("refresh_tokens_user_idx").on(table.userId),
    jtiIdx: uniqueIndex("refresh_tokens_jti_idx").on(table.jti),
    tenantUserIdx: index("refresh_tokens_tenant_user_idx").on(table.businessId, table.userId),
  }),
);

// ---------------------------------------------------------------------------
// Real-estate properties
// ---------------------------------------------------------------------------

export const properties = pgTable(
  "properties",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 50 }),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    transactionType: varchar("transaction_type", { length: 20 }).notNull(),
    propertyType: varchar("property_type", { length: 30 }),
    city: varchar("city", { length: 100 }),
    neighborhood: varchar("neighborhood", { length: 100 }),
    address: text("address"),
    location: text("location").notNull(),
    price: numeric("price").notNull(),
    priceCurrency: varchar("price_currency", { length: 10 }).notNull().default("TOMAN"),
    area: numeric("area").notNull(),
    bedrooms: integer("bedrooms").notNull().default(0),
    bathrooms: integer("bathrooms"),
    yearBuilt: integer("year_built"),
    features: jsonb("features").$type<string[]>().notNull().default([]),
    isAvailable: boolean("is_available").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    businessAvailableIdx: index("properties_business_available_idx").on(table.businessId, table.isAvailable),
    businessTxnIdx: index("properties_business_txn_idx").on(table.businessId, table.transactionType),
    businessCityIdx: index("properties_business_city_idx").on(table.businessId, table.city),
    businessCodeIdx: uniqueIndex("properties_business_code_idx").on(table.businessId, table.code),
  }),
);

// ---------------------------------------------------------------------------
// Webhook idempotency ledger + audit log
// ---------------------------------------------------------------------------

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    scope: varchar("scope", { length: 100 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("processed"),
    payloadHash: varchar("payload_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeKeyIdx: uniqueIndex("webhook_events_scope_key_idx").on(table.businessId, table.scope, table.idempotencyKey),
    tenantIdx: index("webhook_events_tenant_idx").on(table.businessId, table.createdAt),
  }),
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    actorType: varchar("actor_type", { length: 30 }).notNull(),
    actorId: varchar("actor_id", { length: 255 }),
    action: varchar("action", { length: 100 }).notNull(),
    entityType: varchar("entity_type", { length: 50 }),
    entityId: varchar("entity_id", { length: 255 }),
    requestId: varchar("request_id", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    businessCreatedIdx: index("audit_logs_business_created_idx").on(table.businessId, table.createdAt),
    businessActionIdx: index("audit_logs_business_action_idx").on(table.businessId, table.action),
  }),
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type Business = typeof businesses.$inferSelect;
export type User = typeof users.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Call = typeof calls.$inferSelect;
export type CallMessage = typeof callMessages.$inferSelect;
export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type Property = typeof properties.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;

export const identityTokens = pgTable("identity_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: varchar("purpose", { length: 30 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ tokenIdx: uniqueIndex("identity_tokens_hash_idx").on(t.tokenHash), tenantIdx: index("identity_tokens_tenant_idx").on(t.businessId, t.userId) }));

export const agentVersions = pgTable("agent_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ tenantIdx: index("agent_versions_tenant_idx").on(t.businessId, t.agentId, t.createdAt),
  agentTenantFk: foreignKey({ name: "agent_versions_agent_tenant_fk", columns: [t.agentId, t.businessId], foreignColumns: [agents.id, agents.businessId] }).onDelete("cascade") }));

export const automationJobs = pgTable("automation_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  event: varchar("event", { length: 50 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  claimId: uuid("claim_id"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ dedupIdx: uniqueIndex("automation_jobs_dedup_idx").on(t.businessId, t.idempotencyKey), pendingIdx: index("automation_jobs_pending_idx").on(t.status, t.availableAt), tenantIdx: index("automation_jobs_tenant_idx").on(t.businessId, t.createdAt) }));

export const oauthAccounts = pgTable("oauth_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 20 }).notNull(),
  subject: varchar("subject", { length: 255 }).notNull(),
  issuer: varchar("issuer", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ subjectIdx: uniqueIndex("oauth_accounts_subject_idx").on(t.issuer, t.subject), userIdx: uniqueIndex("oauth_accounts_user_provider_idx").on(t.userId, t.provider), tenantIdx: index("oauth_accounts_tenant_idx").on(t.businessId, t.userId) }));

export const crmPipelines = pgTable("crm_pipelines", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 150 }).notNull(),
  stages: jsonb("stages").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ nameIdx: uniqueIndex("crm_pipelines_name_idx").on(t.businessId, t.name), tenantIdIdx: uniqueIndex("crm_pipelines_tenant_id_idx").on(t.businessId, t.id) }));
export const crmOpportunities = pgTable("crm_opportunities", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  pipelineId: uuid("pipeline_id").notNull().references(() => crmPipelines.id, { onDelete: "restrict" }),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  title: varchar("title", { length: 255 }).notNull(),
  stage: varchar("stage", { length: 100 }).notNull(),
  value: numeric("value", { precision: 20, scale: 2 }).notNull().default("0"),
  currency: varchar("currency", { length: 10 }).notNull().default("TOMAN"),
  notes: text("notes").notNull().default(""),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ stageIdx: index("crm_opportunities_stage_idx").on(t.businessId, t.pipelineId, t.stage),
  pipelineTenantFk: foreignKey({ name: "crm_opportunities_pipeline_tenant_fk", columns: [t.pipelineId, t.businessId], foreignColumns: [crmPipelines.id, crmPipelines.businessId] }).onDelete("restrict") }));
export const crmTasks = pgTable("crm_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
  title: varchar("title", { length: 255 }).notNull(),
  notes: text("notes").notNull().default(""),
  status: varchar("status", { length: 20 }).notNull().default("OPEN"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ dueIdx: index("crm_tasks_due_idx").on(t.businessId, t.status, t.dueAt) }));

// Manual-invoice subscriptions. Payment is recorded by an MFA-protected platform operator.
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  plan: varchar("plan", { length: 20 }).notNull().default("FREE"),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
  provider: varchar("provider", { length: 50 }),
  providerSubscriptionId: varchar("provider_subscription_id", { length: 255 }),
  graceUntil: timestamp("grace_until", { withTimezone: true }),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ tenantUnique: uniqueIndex("subscriptions_business_unique").on(t.businessId),
  providerSubIdx: index("subscriptions_provider_sub_idx").on(t.provider, t.providerSubscriptionId) }));
export const billingInvoices = pgTable("billing_invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  plan: varchar("plan", { length: 20 }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  idempotencyKey: uuid("idempotency_key").notNull(),
  customerName: varchar("customer_name", { length: 255 }).notNull(),
  issuer: text("issuer").notNull(),
  paymentInstructions: text("payment_instructions").notNull(),
  paymentReference: varchar("payment_reference", { length: 255 }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ tenantKey: uniqueIndex("billing_invoices_tenant_key").on(t.businessId, t.idempotencyKey),
  referenceUnique: uniqueIndex("billing_invoices_payment_reference").on(t.paymentReference),
  tenantCreated: index("billing_invoices_tenant_created").on(t.businessId, t.createdAt) }));

export const quotaOverrides = pgTable("quota_overrides", {
  businessId: uuid("business_id").primaryKey().references(() => businesses.id, { onDelete: "cascade" }),
  policy: jsonb("policy").$type<Record<string, { hard: number | null; soft: number | null; grace: number }>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const quotaBuckets = pgTable("quota_buckets", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  meter: varchar("meter", { length: 40 }).notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  consumed: numeric("consumed", { precision: 24, scale: 4 }).notNull().default("0"),
  reserved: numeric("reserved", { precision: 24, scale: 4 }).notNull().default("0"),
}, (t) => ({ meterWindow: uniqueIndex("quota_buckets_meter_window").on(t.businessId, t.meter, t.windowStart) }));
export const quotaReservations = pgTable("quota_reservations", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  amounts: jsonb("amounts").$type<Record<string, string>>().notNull(),
  settledAmounts: jsonb("settled_amounts").$type<Record<string, string>>(),
  windows: jsonb("windows").$type<Record<string, string>>().notNull(),
  status: varchar("status", { length: 20 }).notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => ({ tenantKey: uniqueIndex("quota_reservations_tenant_key").on(t.businessId, t.idempotencyKey), pending: index("quota_reservations_pending").on(t.businessId, t.status, t.createdAt) }));

// ---------------------------------------------------------------------------
// P0 hardening — transactional outbox, payment ledger, knowledge governance,
// storage accounting, tenant-scoped machine access and outbound webhooks.
// All tenant-owned rows carry `business_id`; composite foreign keys tie
// dependent rows to the same tenant as their parent.
// ---------------------------------------------------------------------------

/** Application-level idempotency ledger for provider webhooks (tenant-scoped). */
export const providerEvents = pgTable(
  "provider_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 50 }).notNull(),
    scope: varchar("scope", { length: 100 }).notNull(),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }),
    status: varchar("status", { length: 20 }).notNull().default("processed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: uniqueIndex("provider_events_scope_key_idx").on(t.provider, t.scope, t.eventId),
    tenantIdx: index("provider_events_tenant_idx").on(t.businessId, t.createdAt),
  }),
);

/**
 * Transactional outbox. Domain events are inserted in the SAME transaction as
 * the state change; the worker leases rows and performs provider I/O outside
 * any transaction. Retries use exponential backoff and end in `dead`.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    topic: varchar("topic", { length: 80 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    claimId: uuid("claim_id"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantKeyIdx: uniqueIndex("outbox_events_tenant_key_idx").on(t.businessId, t.idempotencyKey),
    pendingIdx: index("outbox_events_pending_idx").on(t.status, t.availableAt),
    tenantIdx: index("outbox_events_tenant_idx").on(t.businessId, t.createdAt),
    topicIdx: index("outbox_events_topic_idx").on(t.businessId, t.topic, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Commercial billing: payment provider lifecycle (additive to manual invoices)
// ---------------------------------------------------------------------------

export const paymentProviders = pgTable(
  "payment_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 50 }).notNull(),
    providerCustomerId: varchar("provider_customer_id", { length: 255 }),
    mode: varchar("mode", { length: 20 }).notNull().default("live"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantProviderIdx: uniqueIndex("payment_providers_tenant_provider_idx").on(t.businessId, t.provider) }),
);

export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").references(() => billingInvoices.id, { onDelete: "set null" }),
    provider: varchar("provider", { length: 50 }).notNull(),
    plan: varchar("plan", { length: 20 }).notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    status: paymentAttemptStatusEnum("status").notNull().default("PENDING"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    providerReference: varchar("provider_reference", { length: 255 }),
    checkoutUrl: text("checkout_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    failureCode: varchar("failure_code", { length: 100 }),
    failureMessage: text("failure_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantKeyIdx: uniqueIndex("payment_attempts_tenant_key_idx").on(t.businessId, t.idempotencyKey),
    providerRefIdx: uniqueIndex("payment_attempts_provider_ref_idx").on(t.provider, t.providerReference),
    tenantCreatedIdx: index("payment_attempts_tenant_created_idx").on(t.businessId, t.createdAt),
    statusIdx: index("payment_attempts_status_idx").on(t.status, t.expiresAt),
  }),
);

/** Immutable financial history. Rows are append-only; corrections use refunds/credit notes. */
export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
    attemptId: uuid("attempt_id").references(() => paymentAttempts.id, { onDelete: "set null" }),
    invoiceId: uuid("invoice_id").references(() => billingInvoices.id, { onDelete: "set null" }),
    kind: paymentTransactionKindEnum("kind").notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    providerTransactionId: varchar("provider_transaction_id", { length: 255 }).notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    plan: varchar("plan", { length: 20 }),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    actorType: varchar("actor_type", { length: 30 }).notNull().default("provider"),
    actorId: varchar("actor_id", { length: 255 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerTxnIdx: uniqueIndex("payment_transactions_provider_txn_idx").on(t.provider, t.providerTransactionId),
    tenantCreatedIdx: index("payment_transactions_tenant_created_idx").on(t.businessId, t.createdAt),
    invoiceIdx: index("payment_transactions_invoice_idx").on(t.invoiceId),
  }),
);

/** Raw provider webhook/event ledger for payment providers (replay protection). */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 50 }).notNull(),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "set null" }),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventIdx: uniqueIndex("payment_events_provider_event_idx").on(t.provider, t.eventId),
    tenantCreatedIdx: index("payment_events_tenant_created_idx").on(t.businessId, t.createdAt.desc().nullsLast()),
  }),
);

export const refundRecords = pgTable(
  "refund_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
    transactionId: uuid("transaction_id").notNull().references(() => paymentTransactions.id, { onDelete: "restrict" }),
    provider: varchar("provider", { length: 50 }).notNull(),
    providerRefundId: varchar("provider_refund_id", { length: 255 }),
    amountMinor: integer("amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    status: refundStatusEnum("status").notNull().default("REQUESTED"),
    reason: text("reason"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    providerRefundIdx: uniqueIndex("refund_records_provider_ref_idx").on(t.provider, t.providerRefundId),
    tenantIdx: index("refund_records_tenant_idx").on(t.businessId, t.createdAt),
  }),
);

export const subscriptionEvents = pgTable(
  "subscription_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 60 }).notNull(),
    fromPlan: varchar("from_plan", { length: 20 }),
    toPlan: varchar("to_plan", { length: 20 }),
    provider: varchar("provider", { length: 50 }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: varchar("actor_type", { length: 30 }).notNull().default("system"),
    actorId: varchar("actor_id", { length: 255 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantIdx: index("subscription_events_tenant_idx").on(t.businessId, t.createdAt) }),
);

export const creditNotes = pgTable(
  "credit_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id").references(() => billingInvoices.id, { onDelete: "set null" }),
    amountMinor: integer("amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    reason: text("reason").notNull(),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantIdx: index("credit_notes_tenant_idx").on(t.businessId, t.createdAt) }),
);

// ---------------------------------------------------------------------------
// Knowledge governance: versioning, ACLs and retrieval analytics
// ---------------------------------------------------------------------------

export const retrievalEvents = pgTable(
  "retrieval_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    queryHash: varchar("query_hash", { length: 64 }).notNull(),
    strategy: varchar("strategy", { length: 30 }).notNull().default("hybrid"),
    candidateCount: integer("candidate_count").notNull().default(0),
    resultCount: integer("result_count").notNull().default(0),
    documentIds: jsonb("document_ids").$type<string[]>().notNull().default([]),
    usedDocumentIds: jsonb("used_document_ids").$type<string[]>().notNull().default([]),
    reranker: varchar("reranker", { length: 50 }),
    rerankMs: integer("rerank_ms"),
    retrievalMs: integer("retrieval_ms").notNull().default(0),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
    outcome: varchar("outcome", { length: 20 }).notNull().default("ok"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index("retrieval_events_tenant_created_idx").on(t.businessId, t.createdAt),
    queryIdx: index("retrieval_events_query_idx").on(t.businessId, t.queryHash),
  }),
);

// ---------------------------------------------------------------------------
// Object storage accounting (authoritative bytes per tenant)
// ---------------------------------------------------------------------------

export const storageObjects = pgTable(
  "storage_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    bytes: numeric("bytes", { precision: 24, scale: 0 }).notNull(),
    contentType: varchar("content_type", { length: 150 }),
    category: varchar("category", { length: 40 }).notNull().default("other"),
    sourceType: varchar("source_type", { length: 40 }),
    sourceId: uuid("source_id"),
    checksum: varchar("checksum", { length: 64 }),
    retainedUntil: timestamp("retained_until", { withTimezone: true }),
    legalHold: boolean("legal_hold").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantKeyIdx: uniqueIndex("storage_objects_tenant_key_idx").on(t.businessId, t.key),
    tenantCategoryIdx: index("storage_objects_tenant_category_idx").on(t.businessId, t.category),
    retentionIdx: index("storage_objects_retention_idx").on(t.retainedUntil),
  }),
);

// ---------------------------------------------------------------------------
// Tenant-defined RBAC, service accounts, API keys and invitations
// ---------------------------------------------------------------------------

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 60 }).notNull(),
    description: varchar("description", { length: 255 }),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantNameIdx: uniqueIndex("roles_tenant_name_idx").on(t.businessId, t.name) }),
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull(),
    permission: varchar("permission", { length: 60 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unique: uniqueIndex("role_permissions_unique_idx").on(t.businessId, t.roleId, t.permission),
    roleIdx: index("role_permissions_role_idx").on(t.roleId),
  }),
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unique: uniqueIndex("user_roles_unique_idx").on(t.businessId, t.userId, t.roleId),
    userIdx: index("user_roles_user_idx").on(t.userId),
  }),
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    prefix: varchar("prefix", { length: 24 }).notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    serviceAccountId: uuid("service_account_id"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: varchar("revoked_reason", { length: 100 }),
    rotatedFromId: uuid("rotated_from_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashIdx: uniqueIndex("api_keys_hash_idx").on(t.keyHash),
    prefixIdx: index("api_keys_prefix_idx").on(t.prefix),
    tenantIdx: index("api_keys_tenant_idx").on(t.businessId, t.createdAt),
  }),
);

export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    description: varchar("description", { length: 255 }),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantNameIdx: uniqueIndex("service_accounts_tenant_name_idx").on(t.businessId, t.name) }),
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    role: userRoleEnum("role").notNull().default("AGENT"),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    resendCount: integer("resend_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex("invitations_token_idx").on(t.tokenHash),
    tenantEmailIdx: uniqueIndex("invitations_tenant_email_idx").on(t.businessId, t.email),
    tenantIdx: index("invitations_tenant_idx").on(t.businessId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Outbound tenant webhooks
// ---------------------------------------------------------------------------

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: varchar("description", { length: 255 }),
    secretHash: varchar("secret_hash", { length: 64 }).notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    failureCount: integer("failure_count").notNull().default(0),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantIdx: index("webhook_endpoints_tenant_idx").on(t.businessId, t.isActive) }),
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    event: varchar("event", { length: 80 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantKeyIdx: uniqueIndex("webhook_deliveries_tenant_key_idx").on(t.endpointId, t.idempotencyKey),
    tenantIdx: index("webhook_deliveries_tenant_idx").on(t.businessId, t.createdAt),
    statusIdx: index("webhook_deliveries_status_idx").on(t.status, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Tenant lifecycle + data export
// ---------------------------------------------------------------------------

export const dataExports = pgTable(
  "data_exports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    scope: jsonb("scope").$type<string[]>().notNull().default([]),
    storageKey: text("storage_key"),
    bytes: numeric("bytes", { precision: 24, scale: 0 }),
    rowCounts: jsonb("row_counts").$type<Record<string, number>>().notNull().default({}),
    error: text("error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantIdx: index("data_exports_tenant_idx").on(t.businessId, t.createdAt) }),
);

export const supportSessions = pgTable(
  "support_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    readOnly: boolean("read_only").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantIdx: index("support_sessions_tenant_idx").on(t.businessId, t.expiresAt) }),
);
