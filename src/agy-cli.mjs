import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { loadJevEnv } from "./env.mjs";
import { routeAgyTier } from "./agy-routing.mjs";
import { loadUserConfig } from "./user-config.mjs";
import { agyConfigForTier, isSupportedAgyEffort, isValidAgyLaunchSpec } from "./agy-models.mjs";
import { createAgyChildRunner } from "./agy-session.mjs";
import { runInteractiveAgy } from "./agy-interactive.mjs";

export { agyConfigForTier, agyModelSlug } from "./agy-models.mjs";

export function resolveAgy(pathValue = process.env.PATH, platform = process.platform) {
  const isWindows = platform === "win32";
  const extensions = isWindows ? [".exe", ".cmd", ".bat"] : [""];
  const directories = (pathValue ?? "").split(isWindows ? ";" : ":").filter(Boolean);

  for (const extension of extensions) {
    for (const directory of directories) {
      const file = join(directory.replace(/^"|"$/g, ""), `agy${extension}`);

      try {
        accessSync(file, constants.F_OK);
        return file;
      } catch {
        // agy is not in this PATH directory.
      }
    }
  }

  return null;
}

export function parseAgyArgs(args) {
  const parsed = { prompt: null, explicitModel: null, explicitEffort: null, passthroughArgs: [] };
  const names = { "--model": "explicitModel", "--effort": "explicitEffort", "-p": "prompt", "--print": "prompt", "--prompt": "prompt" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      parsed.passthroughArgs.push(...args.slice(index));
      break;
    }
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    const field = names[name];
    if (!field) {
      parsed.passthroughArgs.push(arg);
      continue;
    }
    if (parsed[field] !== null) throw new Error(`repeated ${name} option`);
    const inline = arg !== name;
    const value = inline ? arg.slice(name.length + 1) : args[++index];
    if (!value || (!inline && value.startsWith("-"))) {
      throw new Error(`${name} requires a non-empty value`);
    }
    parsed[field] = value;
    if (field !== "explicitEffort") parsed.passthroughArgs.push(...(inline ? [arg] : [name, value]));
  }
  return parsed;
}

export function hasExplicitAgyModel(args) {
  return parseAgyArgs(args).explicitModel !== null;
}

export function promptFromAgyArgs(args) {
  return parseAgyArgs(args).prompt;
}

export function applyAgyTier(args, tier, config = loadUserConfig()) {
  const parsed = parseAgyArgs(args);
  if (parsed.explicitModel !== null) return [...args];
  const resolved = agyConfigForTier(tier, config, parsed.explicitEffort);
  if (!resolved) throw new Error(`no supported Agy model for ${tier} with effort ${parsed.explicitEffort}`);
  return finalAgyLaunchSpec(parsed, resolved).args;
}

function finalAgyLaunchSpec(parsed, routing) {
  const { model, effort, reason } = routing;
  if (!isValidAgyLaunchSpec({ model, effort }) || (parsed.explicitEffort && parsed.explicitEffort !== effort)) {
    throw new Error("routing returned an unsupported Agy model or effort");
  }
  return { model, effort, reason, args: ["--model", model, "--effort", effort, ...parsed.passthroughArgs] };
}

export async function runAgy(args = process.argv.slice(2), {
  config = loadUserConfig(),
  executable = resolveAgy(),
  route = routeAgyTier,
  spawnProcess = spawn,
  stderr = process.stderr,
  env = process.env,
  loadEnv = loadJevEnv,
  interactive = runInteractiveAgy,
  stdout = process.stdout,
} = {}) {
  loadEnv();

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    stdout.write("d3-agy              Interactive per-turn Jev routing\nd3-agy -p \"prompt\"  One-shot routing\nInteractive: /help, /auto, /model <Gemini model slug>, /exit\n");
    return;
  }

  if (!executable) {
    stderr.write(
      "[d3-agy] agy is not installed or is not available on PATH.\n",
    );

    process.exitCode = 1;
    return;
  }

  let parsed;
  try {
    parsed = parseAgyArgs(args);
  } catch (error) {
    stderr.write(`[d3-agy] ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    stderr.write("[d3-agy] Windows batch shims cannot safely receive prompt arguments; install or select agy.exe.\n");
    process.exitCode = 1;
    return;
  }
  // The parser already removed --effort and retained --model in passthroughArgs.
  // Any other native Agy argument keeps the existing native pass-through path.
  const modelArgCount = parsed.explicitModel === null ? 0
    : args.some((arg) => arg.startsWith("--model=")) ? 1 : 2;
  const interactiveArgsOnly = parsed.prompt === null && parsed.passthroughArgs.length === modelArgCount;
  if (interactiveArgsOnly) {
    if (parsed.explicitEffort && !isSupportedAgyEffort(parsed.explicitEffort)) {
      stderr.write(`[d3-agy] unsupported Agy effort: ${parsed.explicitEffort}\n`);
      process.exitCode = 1;
      return;
    }
    const code = await interactive({
      runner: createAgyChildRunner({ executable, spawnProcess, env }),
      route, config, initialModel: parsed.explicitModel,
      initialEffort: parsed.explicitEffort, stderr, output: stdout,
    });
    process.exitCode = code;
    return;
  }
  let finalArgs = [...args];

  const hasJevKey = env.JEV_API_KEY || env.TYPESAFE_API_KEY;

  if (parsed.prompt && parsed.explicitModel === null && hasJevKey) {
    if (parsed.explicitEffort && !isSupportedAgyEffort(parsed.explicitEffort)) {
      stderr.write(`[d3-agy] unsupported Agy effort: ${parsed.explicitEffort}\n`);
      process.exitCode = 1;
      return;
    }
    const routing = await route({
      prompt: parsed.prompt,
      config,
      effortOverride: parsed.explicitEffort,
    });

    const launch = finalAgyLaunchSpec(parsed, routing);
    finalArgs = launch.args;

    stderr.write(
      `[Jev] routed this turn to ${launch.model} ` +
        `(effort ${launch.effort}, ${launch.reason}).\n`,
    );
  }

  const child = spawnProcess(executable, finalArgs, {
    stdio: "inherit",
    shell: false,
    env,
  });

  child.on("error", (error) => {
    stderr.write(`[d3-agy] could not start agy: ${error.message}\n`);

    process.exitCode = 1;
  });

  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}
