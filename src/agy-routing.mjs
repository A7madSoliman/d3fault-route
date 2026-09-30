import { agyConfigForTier, AGY_TIER_ALIASES } from "./agy-models.mjs";
import { decide, detectOverride } from "./policy.mjs";
import { askJev } from "./router.mjs";
import { loadUserConfig } from "./user-config.mjs";
import { TIER_NAMES } from "./core/tiers.mjs";

function agyModels(config, effortOverride, currentTier) {
  const entries = TIER_NAMES;
  const ordered = [
    ...entries.filter((tier) => tier === currentTier),
    ...entries.filter((tier) => tier !== currentTier),
  ];
  const candidates = ordered.flatMap((tier) => {
    const resolved = agyConfigForTier(tier, config, effortOverride);
    if (!resolved) return [];

    return [{
      id: resolved.model,
      tier,
      description: `${resolved.model}; agy ${tier}; effort ${resolved.effort}`,
    }];
  });
  return candidates.filter((candidate, index) =>
    candidates.findIndex((other) => other.id === candidate.id) === index);
}

export async function routeAgyTier({
  prompt,
  currentTier = "strong",
  contextTokens = 0,
  route = askJev,
  config = loadUserConfig(),
  effortOverride = null,
}) {
  const models = agyModels(config, effortOverride, currentTier);
  const currentModel = agyConfigForTier(currentTier, config, effortOverride);
  const activeTier = currentModel ? currentTier : models[0]?.tier;
  const currentConfig = currentModel ?? agyConfigForTier(activeTier, config, effortOverride);
  if (!currentConfig || models.length === 0) throw new Error("no supported Agy models for this effort");

  const jev = await route({
    prompt,
    current: currentConfig.model,
    contextTokens,
    models,
  });

  const chosenModel = models.find((model) => model.id === jev?.choice && model.tier === activeTier)
    ?? models.find((model) => model.id === jev?.choice);

  const decision = decide({
    prompt,
    override: detectOverride(prompt, AGY_TIER_ALIASES),
    jev: jev
      ? {
          ...jev,
          choice: chosenModel?.tier,
        }
      : null,
    current: activeTier,
    available: models.map((model) => model.tier),
    contextTokens,
  });

  const tier = decision.tier;
  const selected = agyConfigForTier(tier, config, effortOverride) ?? currentConfig;

  return {
    tier,
    model: selected.model,
    effort: selected.effort,
    confidence: jev?.confidence ?? null,
    reason: decision.reason,
  };
}
