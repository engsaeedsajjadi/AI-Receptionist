import { afterEach, describe, expect, it } from "vitest";
import {
  CallTimelineSchema,
  OBSERVED_DURATION_GRACE_SECONDS,
  durationTrustMode,
  maxCallMinutes,
  maxSttMinutes,
  observedSeconds,
  resolveBillableDuration,
  voiceQuotaConfig,
} from "@/lib/services/voice-usage";
import {
  KnowledgeAclSchema,
  KnowledgeMetadataFiltersSchema,
  RetrievalPrincipalSchema,
  canAccessDocument,
  knowledgeAccessPredicate,
  knowledgeLifecyclePredicate,
  knowledgeMetadataPredicate,
} from "@/lib/rag/access";
import { db } from "@/db";
import { knowledgeDocuments } from "@/db/schema";
import type { SQL } from "drizzle-orm";
import { resetEnvCache } from "@/lib/env";

const ENV_SNAPSHOT = new Map<string, string | undefined>();
const stubEnv = (key: string, value: string) => {
  if (!ENV_SNAPSHOT.has(key)) ENV_SNAPSHOT.set(key, process.env[key]);
  process.env[key] = value;
  resetEnvCache();
};
afterEach(() => {
  for (const [key, value] of ENV_SNAPSHOT) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ENV_SNAPSHOT.clear();
  resetEnvCache();
});

const sqlText = (query: unknown) => JSON.stringify(query);
/** Render a predicate the way Postgres will receive it (keeps raw fragments). */
const rendered = (predicate: SQL) => db.select().from(knowledgeDocuments).where(predicate).toSQL().sql;

describe("voice usage duration policy", () => {
  it("bounds the reserved airtime and STT windows by configuration", () => {
    expect(maxCallMinutes()).toBe(60);
    expect(maxSttMinutes()).toBe(2);
    for (const raw of ["0", "-5", "nan", "99999"]) {
      stubEnv("VOICE_MAX_CALL_MINUTES", raw);
      expect(maxCallMinutes()).toBe(60);
    }
    stubEnv("VOICE_MAX_CALL_MINUTES", "45");
    expect(maxCallMinutes()).toBe(45);
    for (const raw of ["0", "Infinity", "-1", "900"]) {
      stubEnv("VOICE_STT_RESERVE_MINUTES", raw);
      expect(maxSttMinutes()).toBe(2);
    }
    stubEnv("VOICE_STT_RESERVE_MINUTES", "3");
    expect(maxSttMinutes()).toBe(3);
  });

  it("defaults to trusting the provider and only switches explicitly", () => {
    expect(durationTrustMode()).toBe("provider");
    stubEnv("VOICE_DURATION_TRUST_MODE", "observed");
    expect(durationTrustMode()).toBe("observed");
    stubEnv("VOICE_DURATION_TRUST_MODE", "anything-else");
    expect(durationTrustMode()).toBe("provider");
  });

  it("derives the observed window from the earliest trusted lifecycle instant", () => {
    const endedAt = new Date("2026-03-01T10:00:00.000Z");
    expect(observedSeconds({ startedAt: new Date("2026-03-01T09:59:00.000Z"), metadata: {} }, endedAt)).toBe(60);
    expect(
      observedSeconds(
        { startedAt: new Date("2026-03-01T09:00:00.000Z"), metadata: { connected_at: "2026-03-01T09:59:30.000Z" } },
        endedAt,
      ),
    ).toBe(30);
    expect(
      observedSeconds(
        {
          startedAt: new Date("2026-03-01T09:00:00.000Z"),
          metadata: { connected_at: "2026-03-01T09:00:00.000Z", media_started_at: "2026-03-01T09:59:45.000Z" },
        },
        endedAt,
      ),
    ).toBe(3600); // connect time wins over the later media start
    // No trusted instant at all → the duration is unknown, never invented.
    expect(observedSeconds({ startedAt: null, metadata: {} }, endedAt)).toBeNull();
    // Unparseable metadata falls back to the row timestamp; an unparseable row
    // timestamp yields null rather than NaN.
    expect(observedSeconds({ startedAt: null, metadata: { media_started_at: "not-a-date" } }, endedAt)).toBeNull();
    expect(observedSeconds({ startedAt: new Date("2026-03-01T10:01:00.000Z"), metadata: {} }, endedAt)).toBe(0);
    // A malformed row timestamp is a hard error, never a silently mis-billed 0s call.
    expect(() => observedSeconds({ startedAt: new Date("invalid"), metadata: {} }, endedAt)).toThrow();
  });

  it("combines provider and observed durations without ever billing time it did not carry", () => {
    expect(resolveBillableDuration({ providerSeconds: null, observed: null })).toEqual({
      seconds: 0,
      providerSeconds: null,
      observedSeconds: null,
      varianceSeconds: 0,
      source: "unknown",
    });
    expect(resolveBillableDuration({ providerSeconds: 120, observed: null })).toMatchObject({ seconds: 120, source: "provider" });
    expect(resolveBillableDuration({ providerSeconds: null, observed: 90 })).toMatchObject({ seconds: 90, source: "observed" });
    expect(resolveBillableDuration({ providerSeconds: -10, observed: -5 })).toMatchObject({
      seconds: 0,
      providerSeconds: 0,
      observedSeconds: 0,
      source: "provider",
    });

    const close = resolveBillableDuration({ providerSeconds: 100, observed: 95 });
    expect(close).toMatchObject({ seconds: 100, varianceSeconds: 5, source: "provider" });

    // Provider well above the observed window: flagged, and an operator can flip
    // the policy so the bill is capped by what the app actually carried.
    const over = resolveBillableDuration({ providerSeconds: 300, observed: 60 });
    expect(over).toMatchObject({ seconds: 300, varianceSeconds: 240, source: "provider_over_observed_grace" });
    expect(resolveBillableDuration({ providerSeconds: 300, observed: 60 }, "observed")).toMatchObject({
      seconds: 60,
      varianceSeconds: 240,
      source: "observed",
    });
    expect(OBSERVED_DURATION_GRACE_SECONDS).toBeGreaterThan(0);
  });

  it("validates the call timeline shape strictly", () => {
    expect(CallTimelineSchema.safeParse({}).success).toBe(true);
    expect(CallTimelineSchema.safeParse({ mediaStartedAt: null, connectedAt: null }).success).toBe(true);
    expect(CallTimelineSchema.safeParse({ connectedAt: "2026-03-01T10:00:00+00:00" }).success).toBe(true);
    expect(CallTimelineSchema.safeParse({ connectedAt: "2026-03-01 10:00" }).success).toBe(false);
    expect(CallTimelineSchema.safeParse({ invented: "x" }).success).toBe(false);
  });

  it("reports the voice quota configuration from the environment", () => {
    stubEnv("VOICE_MEDIA_CODEC", "mulaw");
    stubEnv("VOICE_MEDIA_SAMPLE_RATE", "8000");
    const config = voiceQuotaConfig();
    expect(config.maxCallMinutes).toBe(60);
    expect(config.sttReserveMinutes).toBe(2);
    expect(config.mediaCodec).toBe("mulaw");
    expect(Number(config.sampleRate)).toBe(8000);
  });
});

describe("knowledge ACL construction", () => {
  const principal = { role: "AGENT", userId: crypto.randomUUID(), agentId: crypto.randomUUID(), platformSupport: false };

  it("accepts the documented ACL and principal shapes and rejects unknown keys", () => {
    expect(KnowledgeAclSchema.parse({})).toEqual({ roles: [], userIds: [], agentIds: [], categories: [], departments: [] });
    expect(KnowledgeAclSchema.safeParse({ roles: ["AGENT"], unexpected: 1 }).success).toBe(false);
    expect(KnowledgeAclSchema.safeParse({ userIds: ["not-a-uuid"] }).success).toBe(false);
    expect(RetrievalPrincipalSchema.parse({ role: "MANAGER" })).toEqual({
      role: "MANAGER",
      userId: null,
      agentId: null,
      platformSupport: false,
    });
    expect(RetrievalPrincipalSchema.safeParse({ role: "MANAGER", extra: true }).success).toBe(false);
  });

  it("builds the ACL predicate with and without a runtime agent/end user identity", () => {
    const anonymous = knowledgeAccessPredicate({ role: "AGENT", userId: null, agentId: null, platformSupport: false });
    expect(sqlText(anonymous)).toContain("FALSE");
    expect(sqlText(anonymous)).toContain("TENANT");
    const text = rendered(knowledgeAccessPredicate(principal, "d"));
    expect(text).toContain('"d"."acl"');
    expect(text).toContain("agentIds");
    expect(text).toContain("userIds");
    expect(text).toContain("categories");
    expect(text).toContain("departments");
  });

  it("applies the effective window and lifecycle restriction", () => {
    const at = new Date("2026-03-01T00:00:00.000Z");
    const active = sqlText(knowledgeLifecyclePredicate({ tags: [], includeDrafts: false }, at));
    expect(active).toContain("ACTIVE");
    expect(active).not.toContain("DRAFT");
    const drafts = sqlText(knowledgeLifecyclePredicate({ tags: [], includeDrafts: true }, at));
    expect(drafts).toContain("DRAFT");
    const asOf = sqlText(knowledgeLifecyclePredicate({ tags: [], includeDrafts: false, asOf: "2025-01-01T00:00:00Z" }, at));
    expect(asOf).toContain("2025-01-01T00:00:00.000Z");
    expect(rendered(knowledgeLifecyclePredicate({ tags: [], includeDrafts: false }, at, "kd"))).toContain('"kd"."effective_from"');
  });

  it("translates only the supplied metadata filters into SQL", () => {
    expect(knowledgeMetadataPredicate({ tags: [], includeDrafts: false })).toBeUndefined();
    const filters = {
      language: "fa",
      documentType: "policy",
      category: "sales",
      product: "villa",
      service: "valuation",
      branch: "north",
      department: "support",
      tags: ["بروز", "کمیسیون"],
      includeDrafts: false,
    };
    const predicate = knowledgeMetadataPredicate(filters, "kd")!;
    const text = rendered(predicate);
    expect(text).toContain('"kd"."language"');
    expect(text).toContain('"kd"."document_type"');
    expect(text).toContain('"kd"."category"');
    expect(text).toContain('"kd"."department"');
    expect(text).toContain('"kd"."tags"');
    expect(text).toContain("where");
    // Single quotes in tag values are escaped, never interpolated raw.
    expect(rendered(knowledgeMetadataPredicate({ ...filters, tags: ["o'brien"] })!)).toContain("o''brien");
  });

  it("decides document access from the ACL alone", () => {
    expect(RetrievalPrincipalSchema.safeParse({ role: "" }).success).toBe(false);
    const agentOnly = RetrievalPrincipalSchema.parse({ role: "AGENT" });
    expect(canAccessDocument(agentOnly, { visibility: "TENANT", acl: {} })).toBe(true);
    expect(canAccessDocument(principal, { visibility: "ROLE", acl: { roles: ["AGENT"] } })).toBe(true);
    expect(canAccessDocument(principal, { visibility: "ROLE", acl: { roles: ["MANAGER"] } })).toBe(false);
    expect(canAccessDocument(principal, { visibility: "AGENT", acl: { agentIds: [principal.agentId!] } })).toBe(true);
    expect(canAccessDocument(agentOnly, { visibility: "AGENT", acl: { agentIds: [crypto.randomUUID()] } })).toBe(false);
    expect(canAccessDocument(principal, { visibility: "PRIVATE", acl: { userIds: [principal.userId!] } })).toBe(true);
    expect(canAccessDocument(principal, { visibility: "PRIVATE", acl: {} })).toBe(false);
    expect(canAccessDocument(principal, { visibility: "CATEGORY", acl: { categories: ["فروش"] }, category: "فروش" })).toBe(true);
    expect(canAccessDocument(principal, { visibility: "CATEGORY", acl: { departments: ["پشتیبانی"] }, department: "پشتیبانی" })).toBe(true);
    expect(canAccessDocument(principal, { visibility: "CATEGORY", acl: { categories: ["فروش"] }, category: null, department: null })).toBe(false);
    expect(canAccessDocument(principal, { visibility: "UNKNOWN", acl: {} })).toBe(false);
    // Malformed ACL payloads never grant access (they throw at the boundary).
    expect(() => canAccessDocument(principal, { visibility: "ROLE", acl: { roles: "AGENT" } as unknown as Record<string, unknown> })).toThrow();
  });

  it("rejects metadata filters with an inverted or malformed window", () => {
    expect(KnowledgeMetadataFiltersSchema.parse({}).includeDrafts).toBe(false);
    expect(KnowledgeMetadataFiltersSchema.safeParse({ tags: ["x".repeat(61)] }).success).toBe(false);
    expect(KnowledgeMetadataFiltersSchema.safeParse({ asOf: "yesterday" }).success).toBe(false);
    expect(KnowledgeMetadataFiltersSchema.safeParse({ language: "f" }).success).toBe(false);
    expect(KnowledgeMetadataFiltersSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});
