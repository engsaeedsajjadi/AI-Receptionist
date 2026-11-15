import { describe, expect, it } from "vitest";
import { NEUTRAL_SCORE, RUBRIC_VERSION, explainScoreChange, readScoreRationale, scoreLead } from "@/lib/scoring";

/**
 * The rubric must be deterministic and explainable: the same lead always scores
 * the same, every point comes from a named factor, and stronger signals never
 * score lower than weaker ones.
 */
describe("explainable lead scoring", () => {
  const bare = scoreLead({});
  const strong = scoreLead({
    type: "BUY",
    budgetMin: "8000000000",
    budgetMax: "12000000000",
    location: "تهران، سعادت‌آباد، خیابان علامه شمالی",
    minArea: 80,
    maxArea: 120,
    bedrooms: 3,
    timeframe: "this_week",
    requestedVisit: true,
    source: "call",
    summary: "خریدار جدی آپارتمان سه خوابه در سعادت‌آباد با بودجه مشخص",
  });

  it("is deterministic and bounded to 0..100", () => {
    const first = scoreLead({ type: "BUY", location: "تهران", timeframe: "این هفته" });
    const second = scoreLead({ type: "BUY", location: "تهران", timeframe: "این هفته" });
    expect(second).toEqual(first);
    expect(first.rubricVersion).toBe(RUBRIC_VERSION);
    expect(first.score).toBeGreaterThanOrEqual(0);
    expect(first.score).toBeLessThanOrEqual(100);
  });

  it("explains every point with a named factor and a human-readable reason", () => {
    expect(strong.factors.length).toBeGreaterThan(5);
    for (const factor of strong.factors) {
      expect(factor.factor).toMatch(/^[a-z_]+$/);
      expect(factor.reason.length).toBeGreaterThan(5);
      expect(factor.points).not.toBe(0);
    }
    const sum = strong.factors.reduce((total, factor) => total + factor.points, 0);
    expect(strong.explanation).toContain(`baseline ${NEUTRAL_SCORE}`);
    expect(strong.score).toBe(Math.max(0, Math.min(100, Math.round(NEUTRAL_SCORE + sum))));
  });

  it("orders signals the way a sales team would: more information scores higher", () => {
    expect(bare.score).toBe(NEUTRAL_SCORE);
    expect(strong.score).toBeGreaterThan(80);
    // An inverted budget range is still information, but worth less than a valid one.
    const inverted = scoreLead({ budgetMin: "9000", budgetMax: "1000" });
    const valid = scoreLead({ budgetMin: "1000", budgetMax: "9000" });
    expect(valid.score).toBeGreaterThan(inverted.score);
    // A partial extraction is scored on what it produced, and explicit nulls are
    // indistinguishable from absent fields — the score must depend on the values,
    // never on which normaliser happened to write the row.
    const partial = scoreLead({ type: "BUY", location: "تهران" });
    expect(partial.score).toBeGreaterThan(bare.score);
    expect(partial.score).toBeLessThan(strong.score);
    const explicitNulls = scoreLead({ type: "BUY", location: "تهران", budgetMin: null, budgetMax: null, requestedVisit: false, minArea: null, maxArea: null, bedrooms: null, timeframe: null, summary: null });
    expect(explicitNulls).toEqual(partial);
    const visitOnly = scoreLead({ requestedVisit: true });
    expect(visitOnly.factors.find((f) => f.factor === "visit_requested")?.points).toBe(12);
    expect(visitOnly.score).toBe(NEUTRAL_SCORE + 12 + visitOnly.factors.filter((f) => f.points < 0).reduce((t, f) => t + f.points, 0));
  });

  it("accepts Postgres numeric strings without changing the outcome", () => {
    const fromStrings = scoreLead({ type: "RENT", budgetMin: "5000000", budgetMax: "7000000", minArea: "60", bedrooms: "2" });
    const fromNumbers = scoreLead({ type: "RENT", budgetMin: 5_000_000, budgetMax: 7_000_000, minArea: 60, bedrooms: 2 });
    expect(fromStrings).toEqual(fromNumbers);
    // Junk budget values behave like "no budget" instead of NaN-poisoning the score.
    const junk = scoreLead({ type: "RENT", budgetMin: "not-a-number" });
    expect(junk.score).toBe(scoreLead({ type: "RENT" }).score);
  });

  it("explains how a score changed between two rubrics runs", () => {
    const before = scoreLead({ type: "BUY", budgetMin: 1000, budgetMax: 2000, location: "تهران" });
    const after = scoreLead({ type: "BUY", budgetMin: 1000, budgetMax: 2000, location: "تهران", requestedVisit: true, timeframe: "this_week" });
    const change = explainScoreChange(before, after);
    expect(change.from).toBe(before.score);
    expect(change.to).toBe(after.score);
    expect(change.delta).toBe(after.score - before.score);
    expect(change.changes.map((c) => c.factor)).toContain("visit_requested");
    expect(change.changes.map((c) => c.factor)).toContain("timeframe");

    const first = explainScoreChange(null, after);
    expect(first.from).toBeNull();
    expect(first.delta).toBeNull();
    // Re-running with identical input reports no changes.
    expect(explainScoreChange(after, after).changes).toHaveLength(0);
  });

  it("only trusts stored rationales that match the contract", () => {
    expect(readScoreRationale(strong)).toEqual(strong);
    expect(readScoreRationale({ score: 999 })).toBeNull();
    expect(readScoreRationale("nonsense")).toBeNull();
    expect(readScoreRationale({})).toBeNull();
  });
});
