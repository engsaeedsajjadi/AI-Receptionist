import { z } from "zod";
export const METERS = ["calls", "voice_minutes", "stt_minutes", "tts_characters", "llm_input_tokens", "llm_output_tokens", "embedding_tokens", "storage_bytes", "active_agents", "tenant_users"] as const;
export type Meter = typeof METERS[number];
// Number inputs are bounded before conversion to exact fixed-point integer units.
export const QuantitySchema = z.number().finite().nonnegative().max(100_000_000_000);
export const LimitSchema = z.object({ hard: QuantitySchema.nullable(), soft: QuantitySchema.nullable().default(null), grace: QuantitySchema.default(0) }).strict()
  .refine((p) => p.hard === null || p.soft === null || p.soft <= p.hard + p.grace, "Soft limit exceeds admission ceiling");
export const PolicySchema = z.partialRecord(z.enum(METERS), LimitSchema);
export type Policy = z.infer<typeof PolicySchema>;
export const AmountsSchema = z.partialRecord(z.enum(METERS), QuantitySchema).refine((v) => Object.keys(v).length > 0, "At least one meter is required");
export type Amounts = z.infer<typeof AmountsSchema>;
export function planPolicies(raw = process.env.QUOTA_PLANS_JSON): Partial<Record<"FREE" | "STARTER" | "BUSINESS" | "ENTERPRISE", Policy>> {
  return raw ? z.partialRecord(z.enum(["FREE", "STARTER", "BUSINESS", "ENTERPRISE"]), PolicySchema).parse(JSON.parse(raw)) : {};
}
export function units(quantity: number): bigint { return BigInt(Math.ceil(QuantitySchema.parse(quantity) * 10000)); }
export function decimal(value: bigint): string { return `${value / BigInt(10000)}.${(value % BigInt(10000)).toString().padStart(4, "0")}`; }
export function storedUnits(value: string): bigint { const [whole, fraction = ""] = value.split("."); return BigInt(whole) * BigInt(10000) + BigInt(fraction.padEnd(4, "0")); }
export function windowStart(meter: Meter, now = new Date()): Date {
  return ["storage_bytes", "active_agents", "tenant_users"].includes(meter) ? new Date(0) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
export function checkLimit(policy: Policy[Meter], projected: bigint) {
  return { blocked: policy?.hard != null && projected > units(policy.hard) + units(policy.grace),
    warning: policy?.soft != null && projected > units(policy.soft) };
}
