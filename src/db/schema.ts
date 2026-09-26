import {
  boolean,
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

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", ["ADMIN", "MANAGER", "AGENT"]);
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
    /**
     * Dedicated inbound voice number (E.164/national digits, normalised).
     * Unique when set: the deterministic called-number -> business route
     * for inbound telephony (§6). NULL = no voice routing for this business.
     */
    voiceNumber: varchar("voice_number", { length: 30 }),
    address: text("address"),
    timezone: varchar("timezone", { length: 50 }).notNull().default("Asia/Tehran"),
    language: varchar("language", { length: 10 }).notNull().default("fa"),
    isActive: boolean("is_active").notNull().default(true),
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
    voiceNumberIdx: uniqueIndex("businesses_voice_number_idx").on(table.voiceNumber),
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
    role: userRoleEnum("role").notNull().default("AGENT"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index("refresh_tokens_user_idx").on(table.userId),
    jtiIdx: uniqueIndex("refresh_tokens_jti_idx").on(table.jti),
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
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    scope: varchar("scope", { length: 100 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("processed"),
    payloadHash: varchar("payload_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeKeyIdx: uniqueIndex("webhook_events_scope_key_idx").on(table.scope, table.idempotencyKey),
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
