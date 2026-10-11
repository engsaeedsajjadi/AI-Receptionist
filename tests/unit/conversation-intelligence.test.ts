import { describe, expect, it } from "vitest";
import {
  CALLER_INTENTS,
  DEFAULT_INTENT_POLICY,
  IntentSchema,
  SIDE_EFFECT_INTENTS,
  extractSlots,
  intentSummary,
  resolveIntent,
  resolveIntentLocally,
} from "@/lib/services/conversation-intelligence";

describe("typed intent pipeline", () => {
  it("keeps unknown utterances unknown instead of defaulting to a guess", () => {
    const result = resolveIntent({ utterance: "حالت چطوره؟" });
    expect(result.intent).toBe("SMALL_TALK");
    const unknown = resolveIntent({ utterance: "هوم؟" });
    expect(unknown.intent).toBe("UNKNOWN");
    expect(unknown.reason).toBe("no_keyword_match");
    expect(unknown.actionable).toBe(false);
    expect(unknown.needsClarification).toBe(true);
    expect(unknown.confidence).toBe(0);
  });

  it("scores keyword matches and never marks a low-confidence side effect actionable", () => {
    const single = resolveIntentLocally("می‌خواستم بازدید بگیرم");
    expect(single.intent).toBe("VIEWING");
    expect(single.confidence).toBe(0.6);
    expect(SIDE_EFFECT_INTENTS).toContain("VIEWING");
    expect(single.actionable).toBe(false); // 0.6 < 0.75 for a side-effecting intent
    expect(single.reason).toBe("keyword_match:1");

    // The keyword fallback is deliberately conservative: every intent has a
    // single alternation pattern, so a keyword match scores 0.6 — below the
    // action threshold for a side-effecting intent. A local guess can therefore
    // never trigger a write or a transfer on its own.
    const sell = resolveIntentLocally("برای فروش دارم، sell my apartment");
    expect(sell.intent).toBe("SELL");
    expect(sell.confidence).toBe(0.6);
    expect(sell.actionable).toBe(false);
    expect(sell.needsClarification).toBe(false);

    const nonSideEffect = resolveIntentLocally("قیمت این ملک چنده؟");
    expect(nonSideEffect.intent).toBe("PRICING");
    expect(nonSideEffect.actionable).toBe(true);
    expect(nonSideEffect.needsClarification).toBe(false);
  });

  it("normalises Persian and Arabic digits before extracting slots", () => {
    const persian = extractSlots("۳ خوابه در تهران، بودجه تا ۲ میلیارد تومان، شماره ۰۹۱۲۳۴۵۶۷۸۹");
    expect(persian.bedrooms).toBe(3);
    expect(persian.city).toBe("تهران");
    expect(persian.phone).toBe("09123456789");
    expect(Number(persian.budgetMax)).toBeGreaterThan(1_000_000_000);
    const arabic = extractSlots("بودجه تا ۳ میلیارد، ۲ خوابه");
    expect(arabic.bedrooms).toBe(2);
    expect(arabic.budgetMax).toBeTruthy();
    // Unparseable budgets are dropped rather than guessed.
    expect(extractSlots("بودجه تا خیلی زیاد").budgetMax).toBeUndefined();
  });

  it("extracts phone, reference code, property type and transaction type", () => {
    const slots = extractSlots("آپارتمان ۱۰۰ متری برای اجاره، شماره ملک: AB-1042، تلفن 00989121234567");
    expect(slots.phone).toBe("09121234567");
    expect(slots.referenceCode).toBe("AB-1042");
    expect(slots.propertyType).toBe("آپارتمان");
    expect(slots.transactionType).toBe("rent");
    const sale = extractSlots("می‌خوام یک ویلا بخرم در رامسر");
    expect(sale.transactionType).toBe("sale");
    expect(sale.propertyType).toBe("ویلا");
    expect(sale.city).toBe("رامسر");
    expect(extractSlots("سلام")).toEqual({});
  });

  it("validates the model proposal strictly and falls back to the local decision", () => {
    expect(IntentSchema.safeParse({ intent: "BUY", confidence: 0.5 }).success).toBe(true);
    expect(IntentSchema.safeParse({ intent: "NOT_AN_INTENT", confidence: 0.5 }).success).toBe(false);
    expect(IntentSchema.safeParse({ intent: "BUY", confidence: 1.4 }).success).toBe(false);
    expect(IntentSchema.safeParse({ intent: "BUY", confidence: 0.5, injected: true }).success).toBe(false);
    expect(IntentSchema.safeParse({ intent: "BUY", confidence: 0.5, slots: { surprise: 1 } }).success).toBe(false);

    const rejected = resolveIntent({ utterance: "می‌خرم", proposed: { intent: "BUY", confidence: "high" } });
    expect(rejected.reason).toMatch(/^invalid_proposal:/);
    expect(rejected.intent).toBe("BUY"); // local keyword decision still applies
  });

  it("applies the confidence policy per intent class", () => {
    const low = resolveIntent({ utterance: "می‌خرم", proposed: { intent: "BUY", confidence: 0.2 } });
    expect(low.intent).toBe("UNKNOWN");
    expect(low.reason).toBe("low_confidence");
    expect(low.needsClarification).toBe(true);
    expect(low.actionable).toBe(false);

    const sideEffect = resolveIntent({ utterance: "بازدید", proposed: { intent: "VIEWING", confidence: 0.6 } });
    expect(sideEffect.intent).toBe("VIEWING");
    expect(sideEffect.actionable).toBe(false);
    expect(sideEffect.needsClarification).toBe(true);
    expect(sideEffect.reason).toBe("side_effect_requires_confirmation");

    const accepted = resolveIntent({ utterance: "بازدید", proposed: { intent: "VIEWING", confidence: 0.9 } });
    expect(accepted.actionable).toBe(true);
    expect(accepted.reason).toBe("accepted");
    expect(accepted.needsClarification).toBe(false);

    const relaxed = resolveIntent({
      utterance: "می‌خرم",
      proposed: { intent: "BUY", confidence: 0.5 },
      policy: { minIntentConfidence: 0.4 },
    });
    expect(relaxed.intent).toBe("BUY");
    expect(relaxed.actionable).toBe(true);
  });

  it("lets locally extracted slots override model guesses", () => {
    const resolved = resolveIntent({
      utterance: "شماره من ۰۹۱۲۳۴۵۶۷۸۹ و کد ملک: ZZ-9 است، ۳ خوابه در کرج",
      proposed: { intent: "BUY", confidence: 0.9, slots: { phone: "00000000000", bedrooms: 1, city: "شیراز", budgetMax: "1" } },
    });
    expect(resolved.slots.phone).toBe("09123456789");
    expect(resolved.slots.bedrooms).toBe(3);
    expect(resolved.slots.city).toBe("کرج");
    // A model budget survives when the utterance carries none.
    expect(resolved.slots.budgetMax).toBe("1");
  });

  it("summarises intent outcomes without storing utterances", () => {
    const items = [
      resolveIntent({ utterance: "حالت چطوره؟" }),
      resolveIntent({ utterance: "هوم" }),
      resolveIntent({ utterance: "بازدید", proposed: { intent: "VIEWING", confidence: 0.9 } }),
      resolveIntent({ utterance: "بازدید", proposed: { intent: "VIEWING", confidence: 0.9 } }),
    ];
    const summary = intentSummary(items);
    expect(summary.total).toBe(4);
    expect(summary.unknownRate).toBe(0.25);
    expect(summary.byIntent[0]).toEqual({ intent: "VIEWING", count: 2 });
    expect(intentSummary([])).toEqual({ total: 0, unknownRate: null, clarificationRate: null, byIntent: [] });
    expect(CALLER_INTENTS).toContain("HUMAN_HANDOFF");
    expect(DEFAULT_INTENT_POLICY.minActionConfidence).toBeGreaterThan(DEFAULT_INTENT_POLICY.minIntentConfidence);
  });
});
