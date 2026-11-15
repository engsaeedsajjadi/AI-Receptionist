import { z } from "zod";
import { createHash } from "node:crypto";
import { AppError, parseWith } from "@/lib/api";
import { normalizeForSearch } from "@/lib/normalization";

/**
 * Grounded answer verification.
 *
 * The AI answer is split into atomic claims; each claim must be supported by
 * retrieved evidence. Unsupported claims are never silently accepted: they are
 * reported so the caller can be re-prompted or the answer can be avoided.
 * This is a deterministic, offline check (no second model call), which means it
 * can run on every answer and cannot drift with a provider version.
 */

export const ClaimSchema = z
  .object({
    text: z.string().min(3).max(1000),
    /** Evidence ids the claim cites, when the model provided them. */
    evidenceIds: z.array(z.string().min(1).max(200)).max(20).default([]),
  })
  .strict();

export const VerificationInputSchema = z
  .object({
    answer: z.string().min(1).max(20_000),
    evidence: z
      .array(
        z
          .object({
            /**
             * Chunk id for retrieval evidence, or a bounded synthetic id for
             * evidence carried by tool results. Only used in the report.
             */
            id: z.string().min(1).max(200),
            content: z.string().min(1).max(20_000),
            documentId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .max(50),
    /** Below this share of supported claims the answer must not be sent as-is. */
    minSupportRatio: z.number().min(0).max(1).default(0.7),
  })
  .strict();

export type ClaimVerification = {
  claim: string;
  supported: boolean;
  /** Fraction of the claim's content tokens found in evidence. */
  coverage: number;
  evidenceIds: string[];
  reason: "cited" | "lexical_support" | "unsupported" | "no_evidence";
};

export type VerificationReport = {
  claims: ClaimVerification[];
  supportedClaims: number;
  unsupportedClaims: number;
  supportRatio: number | null;
  verdict: "grounded" | "partially_grounded" | "ungrounded" | "no_evidence";
  /** True when the answer may be delivered to the caller as-is. */
  deliverable: boolean;
  answerHash: string;
};

const STOPWORDS = new Set([
  "و", "در", "به", "از", "که", "این", "را", "با", "است", "برای", "تا", "هم", "یا", "یک", "می", "شود", "شده", "های", "ها",
  "the", "a", "an", "of", "to", "in", "is", "are", "and", "or", "for", "on", "with", "we", "you", "it",
]);

function tokens(text: string): string[] {
  return normalizeForSearch(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/** Split a Persian/English answer into atomic claims (sentence level). */
export function splitClaims(answer: string): string[] {
  return answer
    .split(/[\n]+|(?<=[.!?؟!۔])\s+/u)
    .map((part) => part.trim())
    .filter((part) => tokens(part).length >= 2)
    .slice(0, 50);
}

export function verifyClaims(raw: unknown): VerificationReport {
  const input = parseWith(VerificationInputSchema, raw);
  const evidenceTokens = input.evidence.map((item) => ({ id: item.id, tokens: new Set(tokens(item.content)) }));
  const combined = new Set<string>();
  for (const item of evidenceTokens) for (const token of item.tokens) combined.add(token);

  const claims: ClaimVerification[] = splitClaims(input.answer).map((claim) => {
    const claimTokens = tokens(claim);
    if (claimTokens.length === 0) {
      return { claim, supported: false, coverage: 0, evidenceIds: [], reason: "no_evidence" as const };
    }
    const matched = claimTokens.filter((token) => combined.has(token));
    const coverage = Number((matched.length / claimTokens.length).toFixed(4));
    const citing = evidenceTokens.filter((item) => claimTokens.some((token) => item.tokens.has(token))).map((item) => item.id);
    // A claim is supported when most of its content words appear in evidence.
    const supported = coverage >= 0.6 && citing.length > 0;
    return {
      claim,
      supported,
      coverage,
      evidenceIds: citing.slice(0, 10),
      reason: supported ? (citing.length ? "lexical_support" : "cited") : combined.size === 0 ? "no_evidence" : "unsupported",
    };
  });

  const supportedClaims = claims.filter((item) => item.supported).length;
  const unsupportedClaims = claims.length - supportedClaims;
  const supportRatio = claims.length ? Number((supportedClaims / claims.length).toFixed(4)) : null;
  const verdict: VerificationReport["verdict"] =
    claims.length === 0 || combined.size === 0
      ? "no_evidence"
      : unsupportedClaims === 0
        ? "grounded"
        : (supportRatio ?? 0) >= input.minSupportRatio
          ? "partially_grounded"
          : "ungrounded";

  return {
    claims,
    supportedClaims,
    unsupportedClaims,
    supportRatio,
    verdict,
    deliverable: verdict === "grounded" || verdict === "partially_grounded",
    answerHash: createHash("sha256").update(input.answer).digest("hex"),
  };
}

/**
 * Guard used before sending an answer to a caller. When the answer is not
 * grounded, the caller gets an honest message instead of a fabricated one.
 */
export function assertDeliverable(report: VerificationReport, fallbackMessage: string): { text: string; verified: boolean } {
  if (report.deliverable) return { text: "", verified: true };
  if (report.verdict === "no_evidence") return { text: fallbackMessage, verified: false };
  throw new AppError(502, "ANSWER_NOT_GROUNDED", "The generated answer is not supported by the retrieved knowledge");
}

// ---------------------------------------------------------------------------
// Sentiment scoring with an explicit rubric
// ---------------------------------------------------------------------------

export const SENTIMENT_DIMENSIONS = ["intentToProceed", "satisfaction", "urgency", "frustration", "priceSensitivity"] as const;
export type SentimentDimension = (typeof SENTIMENT_DIMENSIONS)[number];

export const SentimentRubric = {
  intentToProceed: ["strong_yes", "yes", "undecided", "no", "strong_no"] as const,
  satisfaction: ["delighted", "satisfied", "neutral", "unhappy", "angry"] as const,
  urgency: ["immediate", "this_week", "this_month", "exploring", "unknown"] as const,
  frustration: ["none", "low", "medium", "high"] as const,
  priceSensitivity: ["budget_focused", "value_focused", "price_insensitive", "unknown"] as const,
};

export const SentimentSchema = z
  .object({
    intentToProceed: z.enum(SentimentRubric.intentToProceed),
    satisfaction: z.enum(SentimentRubric.satisfaction),
    urgency: z.enum(SentimentRubric.urgency).default("unknown"),
    frustration: z.enum(SentimentRubric.frustration).default("none"),
    priceSensitivity: z.enum(SentimentRubric.priceSensitivity).default("unknown"),
    /** Short justification from the transcript (never a free-form opinion). */
    evidence: z.array(z.string().max(200)).max(5).default([]),
  })
  .strict();

export type SentimentResult = z.infer<typeof SentimentSchema> & {
  /** Derived, explainable score in [-1, 1]; null when there is nothing to score. */
  score: number | null;
  /** How the score was produced (rubric weights), for audits. */
  explanation: string;
};

const SATISFACTION_WEIGHT = { delighted: 1, satisfied: 0.6, neutral: 0, unhappy: -0.5, angry: -1 } as const;
const INTENT_WEIGHT = { strong_yes: 1, yes: 0.6, undecided: 0, no: -0.6, strong_no: -1 } as const;
const FRUSTRATION_PENALTY = { none: 0, low: -0.1, medium: -0.3, high: -0.6 } as const;

/** Deterministic rubric scoring: same rubric, same weights, always explained. */
export function scoreSentiment(raw: unknown): SentimentResult {
  const input = parseWith(SentimentSchema, raw);
  const score = Number(
    (
      SATISFACTION_WEIGHT[input.satisfaction] * 0.45 +
      INTENT_WEIGHT[input.intentToProceed] * 0.35 +
      FRUSTRATION_PENALTY[input.frustration] * 0.2
    ).toFixed(4),
  );
  return {
    ...input,
    score,
    explanation: `0.45*satisfaction(${input.satisfaction})=${SATISFACTION_WEIGHT[input.satisfaction]}, 0.35*intent(${input.intentToProceed})=${INTENT_WEIGHT[input.intentToProceed]}, 0.20*frustration(${input.frustration})=${FRUSTRATION_PENALTY[input.frustration]}`,
  };
}

/** Aggregate call sentiment for analytics; never mixes tenants (caller scopes). */
export function sentimentSummary(items: SentimentResult[]) {
  const scored = items.filter((item) => item.score !== null);
  const average = scored.length ? Number((scored.reduce((sum, item) => sum + (item.score ?? 0), 0) / scored.length).toFixed(4)) : null;
  const count = (dimension: SentimentDimension, value: string) => items.filter((item) => (item[dimension] as string) === value).length;
  return {
    calls: items.length,
    averageScore: average,
    atRisk: items.filter((item) => item.satisfaction === "unhappy" || item.satisfaction === "angry" || item.frustration === "high").length,
    readyToProceed: items.filter((item) => item.intentToProceed === "strong_yes" || item.intentToProceed === "yes").length,
    urgency: {
      immediate: count("urgency", "immediate"),
      thisWeek: count("urgency", "this_week"),
      thisMonth: count("urgency", "this_month"),
      exploring: count("urgency", "exploring"),
    },
  };
}
