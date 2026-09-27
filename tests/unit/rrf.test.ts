import { describe, expect, it } from "vitest";
import { reciprocalRankFuse, RRF_K, type RetrievedChunk } from "@/lib/services/knowledge";

function chunk(id: string, source: "vector" | "keyword"): RetrievedChunk {
  return { id, documentId: "doc", documentTitle: "Doc", content: `content-${id}`, score: 0, source };
}

describe("reciprocalRankFuse", () => {
  it("uses the standard k=60 default", () => {
    expect(RRF_K).toBe(60);
  });

  it("scores a single list by rank: 1/(k+rank+1)", () => {
    const fused = reciprocalRankFuse([[chunk("a", "vector"), chunk("b", "vector")]]);
    expect(fused.map((c) => c.id)).toEqual(["a", "b"]);
    expect(fused[0].score).toBeCloseTo(1 / 61, 12);
    expect(fused[1].score).toBeCloseTo(1 / 62, 12);
    expect(fused[0].source).toBe("vector");
  });

  it("returns [] for empty input", () => {
    expect(reciprocalRankFuse([])).toEqual([]);
    expect(reciprocalRankFuse([[], []])).toEqual([]);
  });

  it("merges disjoint lists by RRF score", () => {
    const fused = reciprocalRankFuse([[chunk("v", "vector")], [chunk("k1", "keyword"), chunk("k2", "keyword")]]);
    expect(fused.map((c) => c.id)).toEqual(["v", "k1", "k2"]);
    expect(fused[0].score).toBeCloseTo(1 / 61, 12);
    expect(fused[1].score).toBeCloseTo(1 / 61, 12);
    expect(fused[2].score).toBeCloseTo(1 / 62, 12);
  });

  it("boosts documents returned by both retrievers and marks them 'both'", () => {
    // vector ranks: A #1, B #2. keyword ranks: B #1, C #2.
    const fused = reciprocalRankFuse([
      [chunk("a", "vector"), chunk("b", "vector")],
      [chunk("b", "keyword"), chunk("c", "keyword")],
    ]);
    // B = 1/62 + 1/61 ≈ 0.0325 beats single-list A = 1/61 ≈ 0.0164.
    expect(fused.map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(fused[0].source).toBe("both");
    expect(fused[1].source).toBe("vector");
    expect(fused[2].source).toBe("keyword");
  });

  it("never mixes the input score scales — only ranks matter", () => {
    const inflated = chunk("x", "vector");
    inflated.score = 9999; // cosine similarity scale
    const tiny = chunk("y", "keyword");
    tiny.score = 0.0001; // coverage scale
    const fused = reciprocalRankFuse([[inflated], [tiny]]);
    // Both are rank #1 in their list → tied RRF, input scores ignored.
    expect(fused[0].score).toBeCloseTo(1 / 61, 12);
    expect(fused[1].score).toBeCloseTo(1 / 61, 12);
  });

  it("keeps the original source when a doc repeats within one list", () => {
    const fused = reciprocalRankFuse([[chunk("a", "vector"), chunk("a", "vector")]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].source).toBe("vector");
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12);
  });

  it("honours a custom k", () => {
    const fused = reciprocalRankFuse([[chunk("a", "vector")]], 0);
    expect(fused[0].score).toBeCloseTo(1, 12);
  });

  it("does not mutate the input lists", () => {
    const list = [chunk("a", "vector")];
    reciprocalRankFuse([list, [chunk("a", "keyword")]]);
    expect(list[0].source).toBe("vector");
    expect(list[0].score).toBe(0);
  });
});
