import {
  loadUserConfig,
  resetUserConfig,
  updateUserConfig,
  userConfigPath,
} from "./user-config.mjs";
import { hasJevApiKey, writeJevApiKey } from "./env.mjs";
import { readHiddenInput } from "./secret-input.mjs";

const PROVIDERS = new Set(["agy", "codex", "claude"]);

const TIERS = new Set(["fast", "balanced", "strong", "long"]);

export function formatConfig(path = userConfigPath()) {
  const config = loadUserConfig(path);

  const lines = [`Config: ${path}`, ""];

  for (const provider of ["agy", "codex", "claude"]) {
    lines.push(provider.toUpperCase());

    for (const tier of ["fast", "balanced", "strong", "long"]) {
      const tierConfig = config[provider]?.[tier];

      if (!tierConfig) continue;

      const details = [
        tierConfig.model,
        tierConfig.effort ? `effort=${tierConfig.effort}` : null,
      ].filter(Boolean);

      lines.push(`  ${tier.padEnd(8)} ${details.join("  ")}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function parseSetArgs(args) {
  const [provider, tier, ...options] = args;

  if (!PROVIDERS.has(provider)) {
    throw new Error(`unknown provider: ${provider ?? "(missing)"}`);
  }

  if (!TIERS.has(tier)) {
    throw new Error(`unknown tier: ${tier ?? "(missing)"}`);
  }

  const values = {};

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];

    if (option === "--model") {
      values.model = options[index + 1] ?? null;

      index += 1;
      continue;
    }

    if (option.startsWith("--model=")) {
      values.model = option.slice("--model=".length);

      continue;
    }

    if (option === "--effort") {
      values.effort = options[index + 1] ?? null;

      index += 1;
      continue;
    }

    if (option.startsWith("--effort=")) {
      values.effort = option.slice("--effort=".length);

      continue;
    }

    throw new Error(`unknown option: ${option}`);
  }

  if (!values.model && !values.effort) {
    throw new Error("set requires --model and/or --effort");
  }

  if (values.model === null) {
    throw new Error("--model requires a value");
  }

  if (values.effort === null) {
    throw new Error("--effort requires a value");
  }

  return {
    provider,
    tier,
    values,
  };
}

export async function runConfigCli(
  args = process.argv.slice(2),
  {
    path = userConfigPath(),
    envPath,
    stdout = process.stdout,
    stderr = process.stderr,
    readSecret = readHiddenInput,
  } = {},
) {
  const [command = "show", ...rest] = args;

  if (command === "show") {
    stdout.write(`${formatConfig(path)}\n`);

    return;
  }

  if (command === "set") {
    try {
      const { provider, tier, values } = parseSetArgs(rest);

      updateUserConfig({
        provider,
        tier,
        values,
        path,
      });

      stdout.write(`[d3-config] updated ${provider}.${tier}\n`);

      return;
    } catch (error) {
      stderr.write(`[d3-config] ${error.message}\n`);

      process.exitCode = 1;
      return;
    }
  }

  if (command === "reset") {
    const [provider, tier] = rest;

    if (!PROVIDERS.has(provider)) {
      stderr.write(
        `[d3-config] unknown provider: ${provider ?? "(missing)"}\n`,
      );

      process.exitCode = 1;
      return;
    }

    if (!TIERS.has(tier)) {
      stderr.write(`[d3-config] unknown tier: ${tier ?? "(missing)"}\n`);

      process.exitCode = 1;
      return;
    }

    try {
      resetUserConfig({ provider, tier, path });
      stdout.write(`[d3-config] reset ${provider}.${tier}\n`);
    } catch (error) {
      stderr.write(`[d3-config] ${error.message}\n`);
      process.exitCode = 1;
    }

    return;
  }

  if (command === "key") {
    const [keyCommand] = rest;

    if (keyCommand === "status") {
      stdout.write(
        hasJevApiKey(envPath)
          ? "JEV API key: configured\n"
          : "JEV API key: not configured\n",
      );

      return;
    }

    if (keyCommand === "set") {
      try {
        const apiKey = await readSecret("JEV API key: ", {
          stdin: process.stdin,
          stdout,
        });

        writeJevApiKey(apiKey, envPath);

        stdout.write("JEV API key: saved\n");

        return;
      } catch (error) {
        stderr.write(`[d3-config] ${error.message}\n`);

        process.exitCode = 1;
        return;
      }
    }

    stderr.write(
      `[d3-config] unknown key command: ${keyCommand ?? "(missing)"}\n`,
    );

    process.exitCode = 1;
    return;
  }

  stderr.write(`[d3-config] unknown command: ${command}\n`);

  process.exitCode = 1;
}
