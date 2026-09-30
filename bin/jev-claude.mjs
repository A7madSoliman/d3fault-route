#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../src/proxy.mjs";
import { AUTO_MODEL } from "../src/config.mjs";
import { readSavedModel, restoreSavedModel } from "../src/settings.mjs";
import { LOG_FILE } from "../src/log.mjs";
import { resolveCliExecutable, spawnCliExecutable } from "../src/cli-launch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/**
 * Registers "d3fault-route" as an extra row in Claude Code's /model picker and starts the session
 * on it. Claude Code sends the id verbatim because it does not validate model names behind a
 * custom base URL, which is what lets the proxy tell "route this" from "the user picked a
 * model". Capabilities are declared so Claude Code still composes thinking and effort for
 * the tiers that support them; the proxy strips what the routed model cannot accept.
 */
function autoModelEnv() {
  const env = {
    ANTHROPIC_CUSTOM_MODEL_OPTION: AUTO_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "d3fault-route",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it",
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
      "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
    // Some Claude Code versions validate the model client-side before it reaches the proxy;
    // this defers to the API so "jev-router" can pass through for rewriting.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  };
  // ANTHROPIC_MODEL applies to this session only and is never written to settings, so the
  // default costs the user nothing permanent. A model they set themselves still wins.
  if (!process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = AUTO_MODEL;
  return env;
}

/**
 * Claude Code saves a picker row chosen with Enter as the default for new sessions, so the
 * value from before this session is captured now and put back on the way out.
 */
const savedModelBefore = readSavedModel();

/**
 * Claude Code's UI shows the model it asked for, never the one the proxy routed to, so a
 * status line is the only way to surface the decision. `--settings` merges rather than
 * replaces, but a status line the user configured themselves still takes priority: theirs
 * is a deliberate choice and silently overwriting it would be worse than showing nothing.
 */
function statusLineArgs() {
  if (process.env.JEV_NO_STATUSLINE) return [];
  for (const dir of [join(process.cwd(), ".claude"), join(homedir(), ".claude")]) {
    try {
      if (JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).statusLine) return [];
    } catch {
      // No settings file, or unreadable; nothing to preserve.
    }
  }
  // Pass settings as a file so the CLI receives one stable argument on every platform.
  const command = `"${process.execPath}" "${join(HERE, "jev-statusline.mjs")}"`;
  const file = join(tmpdir(), "jev-claude", "settings.json");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command } }));
  } catch {
    return [];
  }
  return ["--settings", file];
}

// Existing environment variables win, followed by project-local, shared user-level, then
// the legacy Claude-specific file.
for (const file of [
  join(process.cwd(), ".env"),
  join(homedir(), ".jev-router.env"),
  join(homedir(), ".jev-claude.env"),
]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Missing or unreadable; the key may still come from the real environment.
  }
}

const args = process.argv.slice(2);
args.push("--add-dir", ROOT);
const env = { ...process.env };

const claude = resolveCliExecutable("claude");
if (claude?.unsafeShim) {
  process.stderr.write("[jev] Claude Code needs a native claude.exe for safe Windows launch; .cmd/.bat shims cannot receive CLI arguments safely.\n");
  process.exit(1);
}
if (!claude) {
  process.stderr.write(
    "[jev] Claude Code is not installed, or `claude` is not on your PATH.\n" +
      "[jev] d3-claude runs the real Claude Code CLI; install it first:\n" +
      "[jev]   https://code.claude.com/docs/en/setup\n",
  );
  process.exit(1);
}

if (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY) {
  const { port, close } = await startProxy();
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  Object.assign(env, autoModelEnv());
  process.on("exit", () => {
    close();
    restoreSavedModel(savedModelBefore);
  });
  args.push(...statusLineArgs());
  if (process.env.JEV_DEBUG && process.stdout.isTTY) {
    process.stderr.write(`[jev] routing decisions -> ${LOG_FILE}\n`);
  }
} else {
  process.stderr.write(
    `[jev] no JEV_API_KEY found - starting Claude Code without routing\n` +
      `[jev] set it in ${join(homedir(), ".jev-router.env")} to enable routing\n`,
  );
}

const child = spawnCliExecutable(claude, args, { env });

child.on("error", (err) => {
  process.stderr.write(`[jev] could not start Claude Code: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
