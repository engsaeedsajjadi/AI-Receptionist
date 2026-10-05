import { describe, expect, it } from "vitest";
import {
  SENTIMENT_DIMENSIONS,
  SentimentSchema,
  VerificationInputSchema,
  assertDeliverable,
  scoreSentiment,
  sentimentSummary,
  splitClaims,
  verifyClaims,
} from "@/lib/services/answer-quality";
import { AppError } from "@/lib/errors";

const evidenceId = crypto.randomUUID();
const secondEvidenceId = crypto.randomUUID();
const grounded = {
  id: evidenceId,
  content: "کمیسیون فروش در این مجموعه دو درصد مبلغ قرارداد است و در زمان امضای قرارداد دریافت می‌شود.",
};

describe("answer claim verification", () => {
  it("splits an answer into atomic claims and drops fragments", () => {
    const claims = splitClaims("کمیسیون فروش دو درصد است.\nمالیات بر عهده فروشنده است!\nبله\n");
    expect(claims).toHaveLength(2);
    expect(splitClaims("")).toEqual([]);
    expect(splitClaims("بله")).toEqual([]);
    expect(splitClaims("کمیسیون دو درصد است؟").length).toBe(1);
  });

  it("marks every supported claim as grounded and reports a matching hash", () => {
    const report = verifyClaims({
      answer: "کمیسیون فروش دو درصد مبلغ قرارداد است.",
      evidence: [grounded],
    });
    expect(report.verdict).toBe("grounded");
    expect(report.deliverable).toBe(true);
    expect(report.supportedClaims).toBe(1);
    expect(report.unsupportedClaims).toBe(0);
    expect(report.supportRatio).toBe(1);
    expect(report.claims[0].reason).toBe("lexical_support");
    expect(report.claims[0].evidenceIds).toContain(evidenceId);
    expect(report.answerHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyClaims({ answer: "کمیسیون فروش دو درصد مبلغ قرارداد است.", evidence: [grounded] }).answerHash).toBe(report.answerHash);
  });

  it("flags fabricated claims instead of delivering them", () => {
    const report = verifyClaims({
      answer: "کمیسیون فروش بیست درصد مبلغ قرارداد است و پرداخت آن به عهده خریدار می‌باشد.",
      evidence: [grounded],
    });
    expect(report.verdict).toBe("ungrounded");
    expect(report.deliverable).toBe(false);
    expect(report.unsupportedClaims).toBeGreaterThan(0);
    expect(report.claims[0].coverage).toBeLessThan(0.6);
    expect(() => assertDeliverable(report, "اطلاعات کافی ندارم")).toThrow(AppError);
    try {
      assertDeliverable(report, "اطلاعات کافی ندارم");
    } catch (err) {
      expect((err as AppError).code).toBe("ANSWER_NOT_GROUNDED");
      expect((err as AppError).status).toBe(502);
    }
  });

  it("returns the honest fallback when there is no evidence at all", () => {
    const noEvidence = verifyClaims({ answer: "کمیسیون فروش دو درصد است.", evidence: [] });
    expect(noEvidence.verdict).toBe("no_evidence");
    expect(noEvidence.deliverable).toBe(false);
    expect(noEvidence.supportRatio).toBe(0); // no claim can be supported without evidence
    expect(noEvidence.claims[0].reason).toBe("no_evidence");
    expect(assertDeliverable(noEvidence, "متأسفانه اطلاعاتی در این مورد ندارم")).toEqual({
      text: "متأسفانه اطلاعاتی در این مورد ندارم",
      verified: false,
    });
    expect(assertDeliverable(verifyClaims({ answer: "کمیسیون فروش دو درصد مبلغ قرارداد است.", evidence: [grounded] }), "fallback")).toEqual({
      text: "",
      verified: true,
    });
  });

  it("tolerates partial support above the configured ratio but never below it", () => {
    const answer = "کمیسیون فروش دو درصد مبلغ قرارداد است. ساعات کاری دفتر نه تا هجده است.";
    const partial = verifyClaims({ answer, evidence: [grounded, { id: secondEvidenceId, content: "ساعات کاری دفتر نه تا هجده می‌باشد." }] });
    expect(partial.verdict).toBe("grounded");
    const mostlyUnsupported = verifyClaims({
      answer: "کمیسیون فروش دو درصد است. مالیات بر ارزش افزوده ده درصد است. بیمه اجباری است. جریمه تاخیر پنج درصد است.",
      evidence: [grounded],
      minSupportRatio: 0.5,
    });
    expect(mostlyUnsupported.verdict).toBe("ungrounded");
    expect(mostlyUnsupported.supportRatio).toBeLessThan(0.5);
    const relaxed = verifyClaims({
      answer: "کمیسیون فروش دو درصد است. مالیات بر ارزش افزوده ده درصد است.",
      evidence: [grounded],
      minSupportRatio: 0.3,
    });
    expect(["partially_grounded", "grounded"]).toContain(relaxed.verdict);
    expect(relaxed.deliverable).toBe(true);
  });

  it("validates the verification boundary strictly", () => {
    expect(VerificationInputSchema.safeParse({ answer: "x", evidence: [] }).success).toBe(true);
    expect(VerificationInputSchema.safeParse({ answer: "", evidence: [] }).success).toBe(false);
    expect(VerificationInputSchema.safeParse({ answer: "x", evidence: [], extra: 1 }).success).toBe(false);
    expect(VerificationInputSchema.safeParse({ answer: "x", evidence: [{ id: "not-a-uuid", content: "c" }] }).success).toBe(false);
    expect(VerificationInputSchema.safeParse({ answer: "x", evidence: [{ id: evidenceId, content: "c", extra: 1 }] }).success).toBe(false);
    expect(() => verifyClaims({ answer: "x", evidence: "not-an-array" })).toThrow();
  });
});

describe("sentiment rubric", () => {
  it("scores with fixed, explainable weights", () => {
    const positive = scoreSentiment({ intentToProceed: "strong_yes", satisfaction: "delighted", frustration: "none" });
    expect(positive.score).toBe(0.8); // 0.45*1 + 0.35*1 + 0.20*0
    expect(positive.explanation).toContain("0.45*satisfaction(delighted)=1");
    expect(positive.explanation).toContain("0.35*intent(strong_yes)=1");
    expect(positive.explanation).toContain("0.20*frustration(none)=0");
    expect(positive.urgency).toBe("unknown");
    expect(positive.priceSensitivity).toBe("unknown");
    expect(positive.evidence).toEqual([]);

    const negative = scoreSentiment({ intentToProceed: "strong_no", satisfaction: "angry", frustration: "high" });
    expect(negative.score ?? 0).toBeLessThan(-0.9);
    const neutral = scoreSentiment({ intentToProceed: "undecided", satisfaction: "neutral", frustration: "none" });
    expect(neutral.score).toBe(0);
    // Frustration is a penalty that can never flip a delighted caller positive→negative.
    const frustrated = scoreSentiment({ intentToProceed: "yes", satisfaction: "satisfied", frustration: "medium" });
    expect(frustrated.score ?? 0).toBeLessThan(positive.score ?? 0);
    expect(frustrated.score ?? 0).toBeGreaterThan(0);
  });

  it("rejects invented rubric values", () => {
    expect(SentimentSchema.safeParse({ intentToProceed: "strong_yes", satisfaction: "delighted" }).success).toBe(true);
    expect(SentimentSchema.safeParse({ intentToProceed: "maybe", satisfaction: "delighted" }).success).toBe(false);
    expect(SentimentSchema.safeParse({ intentToProceed: "strong_yes", satisfaction: "delighted", score: 1 }).success).toBe(false);
    expect(SentimentSchema.safeParse({ intentToProceed: "yes", satisfaction: "angry", evidence: ["x".repeat(201)] }).success).toBe(false);
    expect(SENTIMENT_DIMENSIONS).toHaveLength(5);
    expect(() => scoreSentiment({})).toThrow();
  });

  it("aggregates tenant sentiment without inventing a score for empty input", () => {
    const items = [
      scoreSentiment({ intentToProceed: "strong_yes", satisfaction: "delighted", urgency: "immediate" }),
      scoreSentiment({ intentToProceed: "yes", satisfaction: "satisfied", urgency: "this_week" }),
      scoreSentiment({ intentToProceed: "no", satisfaction: "unhappy", urgency: "exploring", frustration: "high" }),
      scoreSentiment({ intentToProceed: "undecided", satisfaction: "neutral", urgency: "this_month" }),
    ];
    const summary = sentimentSummary(items);
    expect(summary.calls).toBe(4);
    expect(summary.atRisk).toBe(1);
    expect(summary.readyToProceed).toBe(2);
    expect(summary.urgency).toEqual({ immediate: 1, thisWeek: 1, thisMonth: 1, exploring: 1 });
    const average = summary.averageScore;
    expect(average).not.toBeNull();
    expect(average ?? 0).toBeGreaterThan(-1);
    expect(average ?? 0).toBeLessThan(1);
    expect(sentimentSummary([])).toEqual({
      calls: 0,
      averageScore: null,
      atRisk: 0,
      readyToProceed: 0,
      urgency: { immediate: 0, thisWeek: 0, thisMonth: 0, exploring: 0 },
    });
  });
});
