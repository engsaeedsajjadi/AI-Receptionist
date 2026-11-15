import { z } from "zod";

/**
 * Explainable lead scoring.
 *
 * The score is a deterministic rubric, never a black box: every point comes from
 * a named factor with a weight and the value it was applied to, and the same
 * input always produces the same score, factors and explanation. The rationale is
 * persisted with the lead (`leads.score_rationale`) so a score shown to a customer
 * can always be justified after the fact, and re-scoring an existing lead
 * produces a diff rather than an unexplained jump.
 *
 * Scale: 0–100 (matches `leads.score`). A lead with no information at all scores
 * the neutral baseline, so "unknown" is never silently treated as "bad".
 */

export const NEUTRAL_SCORE = 50;
export const MAX_SCORE = 100;

const URGENT_TIMEFRAMES = ["immediate", "this_week", "this month", "این هفته", "فوری", "فورا"];
const SOON_TIMEFRAMES = ["this_month", "month", "1_month", "این ماه", "یک ماه"];

export type ScoreFactor = {
  /** Machine-readable factor name (stable across releases). */
  factor: string;
  /** Human-readable reason, safe to show to the tenant. */
  reason: string;
  /** Signed contribution to the final score. */
  points: number;
};

export type LeadScoreRationale = {
  score: number;
  baseline: number;
  factors: ScoreFactor[];
  /** One-line summary of the applied rubric. */
  explanation: string;
  /** Rubric version, bumped whenever weights change. */
  rubricVersion: string;
};

export const RUBRIC_VERSION = "lead-score/v1";

/**
 * Signals the rubric reads. Only fields a caller actually provided count.
 * Numbers are accepted as strings too: Postgres `numeric` columns come back from
 * Drizzle as strings, and a rubric must not depend on who normalised the value.
 */
const Numeric = z.union([z.number(), z.string()]).nullable().optional();
export const LeadScoreInputSchema = z.object({
  type: z.string().nullable().optional(),
  budgetMin: Numeric,
  budgetMax: Numeric,
  location: z.string().nullable().optional(),
  minArea: Numeric,
  maxArea: Numeric,
  bedrooms: Numeric,
  timeframe: z.string().nullable().optional(),
  requestedVisit: z.boolean().nullable().optional(),
  source: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});
export type LeadScoreInput = z.infer<typeof LeadScoreInputSchema>;

/** Parses a numeric signal, tolerating numeric strings and rejecting junk. */
function num(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const CONCRETE_TYPES = new Set(["BUY", "RENT", "MORTGAGE", "SELL", "INVESTMENT"]);
const STRONG_SOURCES = new Set(["call", "inbound_call", "webhook"]);
const WEAK_SOURCES = new Set(["manual", "import"]);

function money(value: number | string | null | undefined): boolean {
  const parsed = num(value);
  return parsed !== null && parsed > 0;
}

export function scoreLead(raw: LeadScoreInput): LeadScoreRationale {
  const input = LeadScoreInputSchema.parse(raw);
  const provided = [input.type, input.budgetMin, input.budgetMax, input.location, input.minArea, input.maxArea,
    input.bedrooms, input.timeframe, input.requestedVisit, input.source, input.summary]
    .some((value) => value !== null && value !== undefined && value !== "" && value !== false);
  // Nothing collected yet: the score is the neutral baseline. Missing signals are
  // only penalised once a conversation actually produced some information —
  // "unknown" must never be reported as "bad".
  if (!provided) {
    return {
      score: NEUTRAL_SCORE,
      baseline: NEUTRAL_SCORE,
      factors: [],
      explanation: `No signals collected; baseline ${NEUTRAL_SCORE}/100`,
      rubricVersion: RUBRIC_VERSION,
    };
  }
  const factors: ScoreFactor[] = [];
  const add = (factor: string, points: number, reason: string) => {
    if (points !== 0) factors.push({ factor, reason, points: Math.round(points * 100) / 100 });
  };

  // Intent specificity — a concrete request is worth more than an unspecific one.
  const type = (input.type ?? "").toUpperCase();
  if (CONCRETE_TYPES.has(type)) add("intent", 12, `Lead type ${type} is a concrete transaction request`);
  else if (type === "OTHER") add("intent", -6, "Lead type OTHER carries no transaction signal");

  // Budget — any explicit budget beats an unknown one; ranges are sanity-checked.
  const budgetMin = num(input.budgetMin);
  const budgetMax = num(input.budgetMax);
  const hasMin = money(input.budgetMin);
  const hasMax = money(input.budgetMax);
  if (hasMin && hasMax) {
    if ((budgetMax as number) >= (budgetMin as number)) add("budget", 16, "Explicit budget range supplied");
    else add("budget", 4, "Budget range supplied but inverted (max < min) — treated as unreliable");
  } else if (hasMin || hasMax) {
    add("budget", 9, "Partial budget supplied (single bound)");
  } else {
    add("budget", -8, "No budget information was collected");
  }

  // Requirements detail.
  if (money(input.minArea) || money(input.maxArea)) add("area", 6, "Area requirement supplied");
  const bedrooms = num(input.bedrooms);
  if (bedrooms !== null && bedrooms > 0) add("bedrooms", 5, `${bedrooms} bedroom(s) requested`);
  const location = (input.location ?? "").trim();
  if (location.length >= 3) {
    add("location", 10, "Specific location supplied");
    if (location.length >= 12) add("location_detail", 4, "Location is highly specific (neighbourhood/street level)");
  } else {
    add("location", -6, "No usable location was collected");
  }

  // Urgency and readiness.
  const timeframe = (input.timeframe ?? "").toLowerCase().trim();
  if (URGENT_TIMEFRAMES.some((needle) => timeframe.includes(needle))) add("timeframe", 14, `Urgent timeframe: ${input.timeframe}`);
  else if (SOON_TIMEFRAMES.some((needle) => timeframe.includes(needle))) add("timeframe", 7, `Near-term timeframe: ${input.timeframe}`);
  else if (timeframe) add("timeframe", 1, `Timeframe recorded: ${input.timeframe}`);
  if (input.requestedVisit === true) add("visit_requested", 12, "Caller asked for a viewing");

  // Source quality: a live conversation is a stronger signal than an import.
  const source = (input.source ?? "").toLowerCase().trim();
  if (STRONG_SOURCES.has(source)) add("source", 5, `Lead captured from a live interaction (${source})`);
  else if (WEAK_SOURCES.has(source)) add("source", -4, `Lead entered via ${source}`);

  // A summary means the conversation produced usable context.
  if ((input.summary ?? "").trim().length >= 20) add("summary", 4, "Conversation summary captured");

  const total = factors.reduce((sum, factor) => sum + factor.points, 0);
  const score = Math.max(0, Math.min(MAX_SCORE, Math.round(NEUTRAL_SCORE + total)));
  const explanation =
    factors.length === 0
      ? `No qualifying signals; baseline ${NEUTRAL_SCORE}/100`
      : `${factors.map((f) => `${f.factor}${f.points > 0 ? "+" : ""}${f.points}`).join(", ")} from baseline ${NEUTRAL_SCORE} → ${score}/100`;

  return { score, baseline: NEUTRAL_SCORE, factors, explanation, rubricVersion: RUBRIC_VERSION };
}

/** Difference between two rationales, for "why did this score change?" answers. */
export function explainScoreChange(before: LeadScoreRationale | null, after: LeadScoreRationale): {
  from: number | null;
  to: number;
  delta: number | null;
  changes: Array<{ factor: string; before: number; after: number; reason: string }>;
} {
  const beforeByFactor = new Map((before?.factors ?? []).map((f) => [f.factor, f.points]));
  const afterByFactor = new Map(after.factors.map((f) => [f.factor, f.points]));
  const names = [...new Set([...beforeByFactor.keys(), ...afterByFactor.keys()])].sort();
  const changes = names
    .map((factor) => ({
      factor,
      before: beforeByFactor.get(factor) ?? 0,
      after: afterByFactor.get(factor) ?? 0,
      reason: after.factors.find((f) => f.factor === factor)?.reason ?? "signal no longer present",
    }))
    .filter((change) => change.before !== change.after);
  return {
    from: before ? before.score : null,
    to: after.score,
    delta: before ? after.score - before.score : null,
    changes,
  };
}

/** Stored form: validated on read so a legacy/corrupt value can never break a response. */
export const LeadScoreRationaleSchema = z.object({
  score: z.number().int().min(0).max(100),
  baseline: z.number().int().min(0).max(100),
  factors: z.array(z.object({ factor: z.string(), reason: z.string(), points: z.number() })).max(20),
  explanation: z.string().max(1000),
  rubricVersion: z.string().max(50),
});

export function readScoreRationale(value: unknown): LeadScoreRationale | null {
  const parsed = LeadScoreRationaleSchema.safeParse(value);
  return parsed.success ? (parsed.data as LeadScoreRationale) : null;
}
