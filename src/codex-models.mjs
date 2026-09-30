import { DEFAULT_MODEL_CONFIG } from "./default-config.mjs";
import { TIER_NAMES } from "./core/tiers.mjs";

const FAMILY_TIER = {
  luna: "fast",
  terra: "balanced",
  sol: "strong",
  astra: "long",
};

const MODEL_ENV = {
  fast: "JEV_CODEX_FAST_MODEL",
  balanced: "JEV_CODEX_BALANCED_MODEL",
  strong: "JEV_CODEX_STRONG_MODEL",
  long: "JEV_CODEX_LONG_MODEL",
};

// The project's Codex catalog uses versioned GPT IDs with these four families.
// Numeric versions may change without admitting unrelated providers or GPT-OSS.
export function codexTierOf(model) {
  if (typeof model !== "string") return null;
  const match = /^gpt-\d+(?:\.\d+)?-(luna|terra|sol|astra)$/.exec(model);
  return match ? FAMILY_TIER[match[1]] : null;
}

export const isCodexModel = (model) => codexTierOf(model) !== null;

export function isValidCodexTierModel(tier, model) {
  return TIER_NAMES.includes(tier) && codexTierOf(model) === tier;
}

export function assertValidCodexTierModel(tier, model) {
  if (!isValidCodexTierModel(tier, model)) {
    throw new Error(`unsupported Codex model for ${tier}: ${model ?? "(missing)"}`);
  }
}

/** Native selection wins before this resolver; env > user config > built-in default. */
export function resolveCodexModels(config = DEFAULT_MODEL_CONFIG, env = {}) {
  return Object.fromEntries(TIER_NAMES.map((tier) => {
    const candidates = [
      env[MODEL_ENV[tier]],
      config?.codex?.[tier]?.model,
      DEFAULT_MODEL_CONFIG.codex[tier].model,
    ];
    return [tier, candidates.find((model) => isValidCodexTierModel(tier, model))];
  }));
}

export const codexModelOf = (tier, resolved = resolveCodexModels()) => resolved[tier];
