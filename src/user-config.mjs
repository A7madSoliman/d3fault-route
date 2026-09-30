import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile } from "./atomic-write.mjs";
import { DEFAULT_MODEL_CONFIG } from "./default-config.mjs";
import { isValidAgyConfig, assertValidAgyConfig } from "./agy-models.mjs";
import { isValidCodexTierModel, assertValidCodexTierModel } from "./codex-models.mjs";
import { isValidClaudeTierModel, assertValidClaudeTierModel } from "./claude-models.mjs";

export function userConfigPath(home = homedir()) {
  return join(home, ".jev-router", "config.json");
}

function mergeProvider(defaults, overrides = {}) {
  return Object.fromEntries(
    Object.entries(defaults).map(([tier, config]) => [
      tier,
      {
        ...config,
        ...(overrides[tier] ?? {}),
      },
    ]),
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRawUserConfig(path, { strict = false } = {}) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  try {
    const config = JSON.parse(content);
    if (!isRecord(config)) throw new Error("root must be an object");
    for (const provider of ["agy", "codex", "claude"]) {
      if (config[provider] === undefined) continue;
      if (!isRecord(config[provider])) throw new Error(`${provider} must be an object`);
      for (const [tier, values] of Object.entries(config[provider])) {
        if (!isRecord(values)) throw new Error(`${provider}.${tier} must be an object`);
      }
    }
    return config;
  } catch (error) {
    if (!strict) return {};
    throw new Error(`User config ${path} is invalid (${error.message}); fix or restore the file before running set or reset.`, { cause: error });
  }
}

export function loadUserConfig(path = userConfigPath()) {
  const defaults = structuredClone(DEFAULT_MODEL_CONFIG);

  const userConfig = readRawUserConfig(path);

  return {
    ...defaults,
    agy: Object.fromEntries(Object.entries(mergeProvider(defaults.agy, userConfig.agy)).map(
      ([tier, values]) => [tier, isValidAgyConfig(values) ? values : defaults.agy[tier]],
    )),
    codex: Object.fromEntries(Object.entries(mergeProvider(defaults.codex, userConfig.codex)).map(
      ([tier, values]) => [tier, isValidCodexTierModel(tier, values.model) ? values : defaults.codex[tier]],
    )),
    claude: Object.fromEntries(Object.entries(mergeProvider(defaults.claude, userConfig.claude)).map(
      ([tier, values]) => [tier, isValidClaudeTierModel(tier, values.model) ? values : defaults.claude[tier]],
    )),
  };
}

export function updateUserConfig({
  provider,
  tier,
  values,
  path = userConfigPath(),
}) {
  const config = readRawUserConfig(path, { strict: true });

  config[provider] ??= {};
  config[provider][tier] ??= {};

  config[provider][tier] = {
    ...config[provider][tier],
    ...values,
  };

  if (provider === "agy") {
    const effective = { ...DEFAULT_MODEL_CONFIG.agy[tier], ...config.agy[tier] };
    assertValidAgyConfig(effective);
  }
  if (provider === "codex") {
    const effective = { ...DEFAULT_MODEL_CONFIG.codex[tier], ...config.codex[tier] };
    assertValidCodexTierModel(tier, effective.model);
  }
  if (provider === "claude") {
    const effective = { ...DEFAULT_MODEL_CONFIG.claude[tier], ...config.claude[tier] };
    assertValidClaudeTierModel(tier, effective.model);
  }

  atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`);

  return loadUserConfig(path);
}

export function resetUserConfig({ provider, tier, path = userConfigPath() }) {
  const config = readRawUserConfig(path, { strict: true });

  if (!config[provider]?.[tier]) {
    return loadUserConfig(path);
  }

  delete config[provider][tier];

  if (Object.keys(config[provider]).length === 0) {
    delete config[provider];
  }

  atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`);

  return loadUserConfig(path);
}
