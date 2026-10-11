import { describe, expect, it } from "vitest";
import { requireAnyEnv } from "./live-config";

/**
 * Live embedding acceptance: vectors must have the configured dimension,
 * be normalised enough for cosine search and actually distinguish two
 * different sentences (a constant vector would break retrieval silently).
 */
describe("Live: embedding provider", () => {
  it("returns deterministic-dimension vectors that separate distinct sentences", async () => {
    requireAnyEnv(["OPENAI_API_KEY", "COMPATIBLE_EMBEDDING_BASE_URL"], "embedding provider");
    const { getEmbeddingProvider } = await import("@/lib/providers/embeddings");
    const provider = getEmbeddingProvider();
    const [ra, rb, rc] = await provider.embedMany([
      "قوانین کمیسیون فروش ملک در تهران",
      "ساعات کاری دفتر ما از شنبه تا چهارشنبه است",
      "قوانین کمیسیون فروش ملک در تهران",
    ]);
    const a = ra.embedding, b = rb.embedding, c = rc.embedding;
    expect(ra.dimensions).toBe(a.length);
    expect(a).toHaveLength(b.length);
    expect(a.length).toBeGreaterThan(50);
    const cosine = (x: number[], y: number[]) => {
      let dot = 0, nx = 0, ny = 0;
      for (let i = 0; i < x.length; i += 1) { dot += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
      return dot / (Math.sqrt(nx) * Math.sqrt(ny));
    };
    expect(cosine(a, c)).toBeCloseTo(1, 4);
    expect(cosine(a, b)).toBeLessThan(0.95);
    console.log(`[live:embedding] provider=${provider.name} dim=${a.length} sim(same)=${cosine(a, c).toFixed(4)} sim(diff)=${cosine(a, b).toFixed(4)}`);
  }, 90_000);
});
