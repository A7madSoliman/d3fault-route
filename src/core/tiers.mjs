export const TIER_NAMES = ["fast", "balanced", "strong", "long"];

export const rankOf = (tier) => TIER_NAMES.indexOf(tier);

export const THRESHOLDS = {
  minConfidence: 0.3,
  uncertainCeiling: "balanced",
  downgradeMaxContextTokens: 20000,
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

export const availableTiers = (allowLong = false) =>
  TIER_NAMES.filter((tier) => tier !== "long" || allowLong);

/** Exact-model selection is independent of the provider's model family. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
