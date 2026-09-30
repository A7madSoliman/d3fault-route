import { DEFAULT_MODEL_CONFIG } from "./default-config.mjs";

// Legacy prompt aliases remain an Agy-edge compatibility rule, not core tier IDs.
export const AGY_TIER_ALIASES = {
  fast: ["haiku", "luna"], balanced: ["sonnet", "terra"],
  strong: ["opus", "sol"], long: ["fable", "astra"],
};

// The combinations present in the Agy catalog used by this project.
const AGY_EFFORTS = new Map([
  ["gemini-3.8-flash", new Set(["low", "medium", "high"])],
  ["gemini-3.1-pro", new Set(["high"])],
]);

export function isValidAgyConfig({ model, effort } = {}) {
  return AGY_EFFORTS.get(model)?.has(effort) ?? false;
}

export function isSupportedAgyEffort(effort) {
  return [...AGY_EFFORTS.values()].some((efforts) => efforts.has(effort));
}

export function isValidAgyLaunchSpec({ model, effort } = {}) {
  return typeof model === "string" && typeof effort === "string" && model.endsWith(`-${effort}`)
    && isValidAgyConfig({ model: model.slice(0, -effort.length - 1), effort });
}

export function assertValidAgyConfig(values) {
  if (!isValidAgyConfig(values)) {
    throw new Error(`unsupported Agy model/effort combination: ${values?.model ?? "(missing)"} / ${values?.effort ?? "(missing)"}`);
  }
}

export function agyModelSlug(model, effort) {
  assertValidAgyConfig({ model, effort });
  return `${model}-${effort}`;
}

export function agyConfigForTier(tier, config = DEFAULT_MODEL_CONFIG, effortOverride = null) {
  const fallback = DEFAULT_MODEL_CONFIG.agy[tier];
  if (!fallback) return null;

  const configured = config?.agy?.[tier];
  const values = isValidAgyConfig(configured) ? configured : fallback;
  const effort = effortOverride ?? values.effort;
  if (!isValidAgyConfig({ model: values.model, effort })) return null;

  return { model: agyModelSlug(values.model, effort), effort };
}
