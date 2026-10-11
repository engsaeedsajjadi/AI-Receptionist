import { z } from "zod";
import { AppError, parseWith } from "@/lib/api";
import { logInfo } from "@/lib/logger";
import { normalizeForSearch, normalizePersianText, parsePrice } from "@/lib/normalization";

/**
 * Typed intent pipeline.
 *
 * The LLM proposes an intent; this module is the *typed* boundary that decides
 * what actually happens. Everything is validated, unknown intents stay unknown
 * (never silently mapped to a default), and confidence is required to cross
 * configurable thresholds before a side effect is allowed.
 */

export const CALLER_INTENTS = [
  "BUY",
  "RENT",
  "SELL",
  "VALUATION",
  "VIEWING",
  "FOLLOW_UP",
  "PRICING",
  "SUPPORT",
  "COMPLAINT",
  "BILLING",
  "CANCEL",
  "HUMAN_HANDOFF",
  "SMALL_TALK",
  "UNKNOWN",
] as const;
export type CallerIntent = (typeof CALLER_INTENTS)[number];

/** Intents that may trigger a write or a transfer; these need higher confidence. */
export const SIDE_EFFECT_INTENTS: CallerIntent[] = ["VIEWING", "SELL", "HUMAN_HANDOFF", "CANCEL", "COMPLAINT"];

export const IntentSchema = z
  .object({
    intent: z.enum(CALLER_INTENTS),
    confidence: z.number().min(0).max(1),
    slots: z
      .object({
        propertyType: z.string().max(40).optional(),
        transactionType: z.enum(["sale", "rent"]).optional(),
        bedrooms: z.number().int().min(0).max(20).optional(),
        city: z.string().max(80).optional(),
        neighborhood: z.string().max(80).optional(),
        budgetMax: z.string().max(30).optional(),
        budgetMin: z.string().max(30).optional(),
        timing: z.string().max(80).optional(),
        phone: z.string().max(20).optional(),
        fullName: z.string().max(150).optional(),
        referenceCode: z.string().max(50).optional(),
      })
      .strict()
      .default({}),
    /** Utterance excerpt the decision was made from (bounded, no secrets). */
    evidence: z.string().max(400).optional(),
  })
  .strict();

export type IntentDecision = z.infer<typeof IntentSchema>;

export type IntentPolicy = {
  /** Minimum confidence to act on a side-effecting intent. */
  minActionConfidence: number;
  /** Below this the intent is reported as UNKNOWN and the caller is asked again. */
  minIntentConfidence: number;
};

export const DEFAULT_INTENT_POLICY: IntentPolicy = { minActionConfidence: 0.75, minIntentConfidence: 0.4 };

export type ResolvedIntent = {
  intent: CallerIntent;
  confidence: number;
  slots: IntentDecision["slots"];
  /** True when the intent is reliable enough to act on. */
  actionable: boolean;
  /** True when the caller must be asked to repeat/clarify. */
  needsClarification: boolean;
  reason: string;
};

const PHONE_PATTERN = /(?:\+98|0098|98|0)?9\d{9}/;
/**
 * `\b` is an ASCII word boundary: Persian letters are not `\w`, so `\bکد`
 * never matches Persian text. The boundary is therefore expressed with Unicode
 * property escapes and the `u` flag, which works for both scripts.
 */
const REFERENCE_PATTERN = /(?:^|[^\p{L}\p{N}])(?:کد|شماره ملک|reference|ref)[\s:#]*([A-Za-z0-9-]{3,20})(?![\p{L}\p{N}])/iu;

/** Persian/Arabic digits and spoken numbers are normalised before matching. */
function normalizeDigits(text: string): string {
  return text.replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

const INTENT_KEYWORDS: Array<{ intent: CallerIntent; patterns: RegExp[] }> = [
  { intent: "HUMAN_HANDOFF", patterns: [/اپراتور|مسئول|انسان|کارشناس واقعی|human|representative|operator/i] },
  { intent: "CANCEL", patterns: [/لغو|کنسل|cancel|دیگه نمی‌خوام/i] },
  { intent: "COMPLAINT", patterns: [/شکایت|ناراضی|complaint|خیلی بد|افتضاح/i] },
  { intent: "BILLING", patterns: [/فاکتور|صورت‌حساب|پرداخت|هزینه اشتراک|invoice|billing/i] },
  { intent: "SUPPORT", patterns: [/پشتیبانی|مشکل فنی|خراب|support|bug/i] },
  { intent: "VALUATION", patterns: [/کارشناسی|قیمت‌گذاری ملک|چقدر می‌ارزه|valuation|appraisal/i] },
  { intent: "VIEWING", patterns: [/بازدید|دیدن ملک|وقت ملاقات|appointment|viewing/i] },
  { intent: "SELL", patterns: [/می‌خوام بفروشم|برای فروش دارم|sell my/i] },
  { intent: "RENT", patterns: [/اجاره|رهن|rent/i] },
  { intent: "BUY", patterns: [/می‌خرم|خرید|buy|purchase/i] },
  { intent: "FOLLOW_UP", patterns: [/پیگیری|قبلاً صحبت|follow up|following up/i] },
  { intent: "PRICING", patterns: [/قیمت|چند|تعرفه|price|how much/i] },
  { intent: "SMALL_TALK", patterns: [/سلامت|خوبی|حالت چطوره|how are you/i] },
];

/**
 * Deterministic, explainable intent resolution used as the fallback when the
 * LLM does not answer or answers with an unusable confidence.
 */
export function resolveIntentLocally(utterance: string): ResolvedIntent {
  const text = normalizeDigits(utterance);
  const scored = INTENT_KEYWORDS.map(({ intent, patterns }) => ({ intent, hits: patterns.filter((p) => p.test(text)).length })).filter((entry) => entry.hits > 0);
  const slots = extractSlots(text);
  if (scored.length === 0) {
    return { intent: "UNKNOWN", confidence: 0, slots, actionable: false, needsClarification: true, reason: "no_keyword_match" };
  }
  const best = scored.sort((a, b) => b.hits - a.hits)[0];
  const confidence = best.hits >= 2 ? 0.8 : 0.6;
  return {
    intent: best.intent,
    confidence,
    slots,
    actionable: confidence >= DEFAULT_INTENT_POLICY.minActionConfidence || !SIDE_EFFECT_INTENTS.includes(best.intent),
    needsClarification: false,
    reason: `keyword_match:${best.hits}`,
  };
}

export function extractSlots(text: string): IntentDecision["slots"] {
  const slots: IntentDecision["slots"] = {};
  const normalized = normalizeForSearch(text);
  const phone = PHONE_PATTERN.exec(normalizeDigits(text));
  if (phone) slots.phone = phone[0].replace(/^(\+98|0098|98)/, "0");
  const reference = REFERENCE_PATTERN.exec(text);
  if (reference) slots.referenceCode = reference[1];
  const bedrooms = /(\d+)\s*(?:خوابه|خواب(?:ه)?|اتاق)/.exec(normalizeDigits(text));
  if (bedrooms) slots.bedrooms = Number(bedrooms[1]);
  const typeMatch = ["آپارتمان", "ویلا", "زمین", "دفتر", "مغازه", "سوئیت"].find((type) => normalized.includes(normalizeForSearch(type)));
  if (typeMatch) slots.propertyType = typeMatch;
  if (/اجاره|رهن/.test(text)) slots.transactionType = "rent";
  else if (/خرید|بخرم|می‌خرم|فروش/.test(text)) slots.transactionType = "sale";
  const budget = /(?:بودجه|تا|حداکثر|زیر)\s*([^،.؛\n]{2,30})/.exec(normalizePersianText(text));
  if (budget) {
    const parsed = parsePrice(budget[1]);
    if (parsed) slots.budgetMax = String(parsed.amountToman);
  }
  for (const city of ["تهران", "کرج", "مشهد", "اصفهان", "شیراز", "تبریز", "رشت", "قم", "اهواز", "رامسر"]) {
    if (normalized.includes(normalizeForSearch(city))) {
      slots.city = city;
      break;
    }
  }
  return slots;
}

/**
 * Final decision: validates the model's proposal, merges locally extracted
 * slots (the model never has to invent a phone number), and applies policy.
 */
export function resolveIntent(input: {
  utterance: string;
  proposed?: unknown;
  policy?: Partial<IntentPolicy>;
}): ResolvedIntent {
  const policy = { ...DEFAULT_INTENT_POLICY, ...input.policy };
  const local = resolveIntentLocally(input.utterance);
  if (input.proposed === undefined) return local;

  let decision: IntentDecision;
  try {
    decision = parseWith(IntentSchema, input.proposed);
  } catch (err) {
    if (err instanceof AppError) {
      logInfo("Intent proposal rejected by the typed boundary", {
        operation: "intent.resolve",
        status: "invalid",
        errorCode: err.code,
      });
      return { ...local, reason: `invalid_proposal:${err.code}` };
    }
    throw err;
  }

  // Locally extracted high-precision slots win over model guesses.
  const slots = { ...decision.slots, ...local.slots, budgetMax: local.slots.budgetMax ?? decision.slots.budgetMax };
  const belowClarification = decision.confidence < policy.minIntentConfidence;
  const sideEffect = SIDE_EFFECT_INTENTS.includes(decision.intent);
  const actionable = !belowClarification && (!sideEffect || decision.confidence >= policy.minActionConfidence);
  return {
    intent: belowClarification ? "UNKNOWN" : decision.intent,
    confidence: decision.confidence,
    slots,
    actionable,
    needsClarification: belowClarification || !actionable,
    reason: belowClarification ? "low_confidence" : actionable ? "accepted" : "side_effect_requires_confirmation",
  };
}

/**
 * Intent outcome statistics for a set of resolved decisions (used by the AI
 * quality dashboard). Never stores the utterance verbatim.
 */
export function intentSummary(items: ResolvedIntent[]) {
  const total = items.length;
  const unknown = items.filter((item) => item.intent === "UNKNOWN").length;
  const lowConfidence = items.filter((item) => item.needsClarification).length;
  const byIntent = new Map<CallerIntent, number>();
  for (const item of items) byIntent.set(item.intent, (byIntent.get(item.intent) ?? 0) + 1);
  return {
    total,
    unknownRate: total ? Number((unknown / total).toFixed(4)) : null,
    clarificationRate: total ? Number((lowConfidence / total).toFixed(4)) : null,
    byIntent: [...byIntent.entries()].map(([intent, count]) => ({ intent, count })).sort((a, b) => b.count - a.count),
  };
}
