import { describe, expect, it } from "vitest";
import { requireAnyEnv } from "./live-config";

/**
 * Live LLM acceptance: a real provider call must return a usable completion.
 * Fails loudly (never skips) when no live provider credential is configured.
 */
describe("Live: LLM provider round trip", () => {
  it("answers a Persian prompt with a non-empty completion from the live provider", async () => {
    requireAnyEnv(["OPENAI_API_KEY", "COMPATIBLE_LLM_BASE_URL", "ANTHROPIC_API_KEY"], "LLM provider");
    const { getLLMProvider } = await import("@/lib/providers/llm");
    const provider = getLLMProvider();
    const started = Date.now();
    const result = await provider.complete(
      [
        { role: "system", content: "پاسخ را فقط با یک جمله فارسی بده." },
        { role: "user", content: "ساعات کاری یک آژانس املاک معمولاً چند تا چند است؟" },
      ],
      { maxTokens: 200, temperature: 0 },
    );
    expect(provider.name).not.toBe("dev");
    expect((result.content ?? "").trim().length).toBeGreaterThan(10);
    // Persian script must survive the round trip.
    expect(result.content ?? "").toMatch(/[\u0600-\u06FF]/);
    console.log(`[live:llm] provider=${provider.name} latencyMs=${Date.now() - started} chars=${(result.content ?? "").length}`);
  }, 90_000);
});
