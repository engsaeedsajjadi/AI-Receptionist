import {
  boolean,
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
} from "drizzle-orm/pg-core";

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
  "ANSWERED",
  "COMPLETED",
  "MISSED",
  "FAILED",
  "TRANSFERRED",
]);
export const callMessageRoleEnum = pgEnum("call_message_role", ["CUSTOMER", "AGENT", "SYSTEM", "TOOL"]);
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "REQUESTED",
  "SCHEDULED",
  "CANCELLED",
  "COMPLETED",
]);
export const notificationStatusEnum = pgEnum("notification_status", ["PENDING", "SENT", "FAILED"]);

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: uniqueIndex("users_email_idx").on(table.email),
  }),
);

export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 150 }).notNull(),
  systemPrompt: text("system_prompt").notNull().default(""),
  voiceProvider: varchar("voice_provider", { length: 100 }).notNull().default("mock"),
  voiceId: varchar("voice_id", { length: 100 }).notNull().default("fa-default"),
  language: varchar("language", { length: 20 }).notNull().default("fa-IR"),
  isActive: boolean("is_active").notNull().default(true),
  configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customers = pgTable("customers", {
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
});

export const leads = pgTable("leads", {
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
  notes: text("notes"),
  assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const calls = pgTable("calls", {
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
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const callMessages = pgTable("call_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  callId: uuid("call_id")
    .notNull()
    .references(() => calls.id, { onDelete: "cascade" }),
  role: callMessageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
});

export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  sourceType: varchar("source_type", { length: 50 }).notNull().default("manual"),
  sourceUrl: text("source_url"),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  embedding: jsonb("embedding").$type<number[] | null>(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appointments = pgTable("appointments", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  status: appointmentStatusEnum("status").notNull().default("REQUESTED"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  type: varchar("type", { length: 50 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  status: notificationStatusEnum("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageRecords = pgTable("usage_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 50 }).notNull(),
  quantity: numeric("quantity").notNull(),
  unit: varchar("unit", { length: 30 }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const properties = pgTable("properties", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  transactionType: varchar("transaction_type", { length: 20 }).notNull(),
  location: text("location").notNull(),
  price: numeric("price").notNull(),
  area: numeric("area").notNull(),
  bedrooms: integer("bedrooms").notNull().default(0),
  isAvailable: boolean("is_available").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
