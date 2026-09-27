/**
 * Provider pricing table (configuration/data — NOT hardcoded in business logic).
 *
 * Default rates are conservative USD estimates and can be overridden at
 * runtime via the PRICING_JSON env var:
 *   PRICING_JSON='{"llm_input_tokens":{"perUnit":0.00000015,"unit":"token"}}'
 *
 * Costs are always recorded as estimates (estimated_cost) alongside the raw
 * provider-reported usage quantities.
 */

export type PricingRate = {
  /** Cost in USD per `per` units. */
  perUnit: number;
  per: number;
  unit: string;
};

export const DEFAULT_PRICING: Record<string, PricingRate> = {
  llm_input_tokens: { perUnit: 0.00000015, per: 1, unit: "token" },
  llm_output_tokens: { perUnit: 0.0000006, per: 1, unit: "token" },
  embedding_tokens: { perUnit: 0.00000002, per: 1, unit: "token" },
  stt_minutes: { perUnit: 0.006, per: 1, unit: "minute" },
  tts_characters: { perUnit: 0.000015, per: 1, unit: "character" },
  voice_minutes: { perUnit: 0.02, per: 1, unit: "minute" },
  calls: { perUnit: 0, per: 1, unit: "count" },
  storage_bytes: { perUnit: 0.000000000023, per: 1, unit: "byte" },
  notifications: { perUnit: 0, per: 1, unit: "count" },
};

function loadOverrides(): Record<string, Partial<PricingRate>> {
  const raw = process.env.PRICING_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, Partial<PricingRate>>;
  } catch {
    return {};
  }
}

export function getPricing(): Record<string, PricingRate> {
  const overrides = loadOverrides();
  const merged: Record<string, PricingRate> = { ...DEFAULT_PRICING };
  for (const [key, value] of Object.entries(overrides)) {
    if (merged[key] && typeof value?.perUnit === "number") {
      merged[key] = { ...merged[key], ...value };
    }
  }
  return merged;
}

/** Estimate USD cost for a usage type + quantity. Returns null when unknown. */
export function estimateCost(type: string, quantity: number): number | null {
  if (!Number.isFinite(quantity) || quantity < 0) return null;
  const rate = getPricing()[type];
  if (!rate) return null;
  return (quantity / rate.per) * rate.perUnit;
}
