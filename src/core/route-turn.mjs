import { askJev } from "../router.mjs";
import { decide } from "../policy.mjs";
import { shouldUseExactModel, TIER_NAMES } from "./tiers.mjs";

/** Select only from provider-filtered candidates, preferring the configured model for a tier. */
export function modelForTier(candidates, tier, preferredModels = {}) {
  return candidates.find((candidate) => candidate.tier === tier && candidate.id === preferredModels[tier])?.id
    ?? candidates.find((candidate) => candidate.tier === tier)?.id
    ?? candidates.find((candidate) => candidate.tier === "strong" && candidate.id === preferredModels.strong)?.id
    ?? candidates.find((candidate) => candidate.tier === "strong")?.id
    ?? candidates[0]?.id;
}

/** Provider-neutral Jev → policy → exact model/fallback decision for a fresh proxy turn. */
export async function routeTurn({
  prompt,
  currentModel,
  currentTier,
  contextTokens = 0,
  candidates,
  availableTiers = TIER_NAMES,
  preferredModels = {},
  override = null,
  route = askJev,
}) {
  const eligible = candidates.filter((candidate) => availableTiers.includes(candidate.tier));
  if (eligible.length === 0) throw new Error("no available routing candidates");
  const available = [...new Set(eligible.map((candidate) => candidate.tier))];
  const safeCurrentModel = eligible.some((candidate) => candidate.id === currentModel)
    ? currentModel
    : modelForTier(eligible, currentTier, preferredModels);
  let jev;
  try {
    jev = await route({ prompt, current: safeCurrentModel, contextTokens, models: eligible });
  } catch {
    jev = null;
  }
  const chosen = eligible.find((candidate) => candidate.id === jev?.choice);
  const decision = decide({
    prompt,
    override,
    jev: jev && { ...jev, choice: chosen?.tier },
    current: currentTier,
    available,
    contextTokens,
  });
  const model = shouldUseExactModel(decision.reason, chosen?.tier, decision.tier)
    ? chosen.id
    : decision.tier === currentTier
      ? safeCurrentModel
      : modelForTier(eligible, decision.tier, preferredModels);
  if (!eligible.some((candidate) => candidate.id === model)) {
    throw new Error("routing produced a model outside the candidate set");
  }
  return {
    tier: decision.tier,
    model,
    confidence: jev?.confidence ?? null,
    reason: decision.reason,
    jev,
  };
}
