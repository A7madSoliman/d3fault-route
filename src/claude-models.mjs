import { DEFAULT_MODEL_CONFIG } from "./default-config.mjs";
import { TIER_NAMES } from "./core/tiers.mjs";

const FAMILY_TIER = {
  haiku: "fast",
  sonnet: "balanced",
  opus: "strong",
  fable: "long",
};

// These families and version shapes are represented by the built-in defaults and catalog tests.
// A context-window suffix is part of the catalog ID, not a different provider or tier.
export function tierOf(model) {
  if (typeof model !== "string") return null;
  const match = /^claude-(haiku|sonnet|opus|fable)-\d+(?:-\d+)*(?:\[\d+[mk]\])?$/.exec(model);
  return match ? FAMILY_TIER[match[1]] : null;
}

export const isClaudeModel = (model) => tierOf(model) !== null;
export const isValidClaudeTierModel = (tier, model) => TIER_NAMES.includes(tier) && tierOf(model) === tier;

export function assertValidClaudeTierModel(tier, model) {
  if (!isValidClaudeTierModel(tier, model)) {
    throw new Error(`unsupported Claude model for ${tier}: ${model ?? "(missing)"}`);
  }
}

export const TIERS = [
  { name: "fast", family: "haiku", thinking: false, effort: false },
  { name: "balanced", family: "sonnet", thinking: true, effort: true },
  { name: "strong", family: "opus", thinking: true, effort: true },
  { name: "long", family: "fable", thinking: true, effort: true },
].map((tier) => ({ ...tier, id: DEFAULT_MODEL_CONFIG.claude[tier.name].model }));

export const tierSpec = (tier) => TIERS.find((item) => item.name === tier);

/** Native ANTHROPIC_MODEL/manual selection precedes routing; no legacy tier-model env exists. */
export function resolveClaudeModels(config = DEFAULT_MODEL_CONFIG) {
  return Object.fromEntries(TIER_NAMES.map((tier) => [
    tier,
    [config?.claude?.[tier]?.model, DEFAULT_MODEL_CONFIG.claude[tier].model]
      .find((model) => isValidClaudeTierModel(tier, model)),
  ]));
}

export const idOf = (tier, resolved = resolveClaudeModels()) => resolved[tier];
