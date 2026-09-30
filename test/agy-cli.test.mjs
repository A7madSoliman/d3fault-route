import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  agyConfigForTier,
  agyModelSlug,
  applyAgyTier,
  hasExplicitAgyModel,
  parseAgyArgs,
  promptFromAgyArgs,
  resolveAgy,
  runAgy,
} from "../src/agy-cli.mjs";

import { DEFAULT_MODEL_CONFIG } from "../src/default-config.mjs";
import { routeAgyTier } from "../src/agy-routing.mjs";

test("finds agy on PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "agy-path-"));
  try {
    writeFileSync(join(directory, "agy.cmd"), "");
    assert.equal(resolveAgy(directory, "win32"), join(directory, "agy.cmd"));
    assert.equal(resolveAgy("", "win32"), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("maps agy tiers to model and effort", () => {
  assert.deepEqual(agyConfigForTier("fast", DEFAULT_MODEL_CONFIG), {
    model: "gemini-3.8-flash-low",
    effort: "low",
  });

  assert.deepEqual(agyConfigForTier("balanced", DEFAULT_MODEL_CONFIG), {
    model: "gemini-3.8-flash-medium",
    effort: "medium",
  });

  assert.deepEqual(agyConfigForTier("strong", DEFAULT_MODEL_CONFIG), {
    model: "gemini-3.8-flash-high",
    effort: "high",
  });

  assert.deepEqual(agyConfigForTier("long", DEFAULT_MODEL_CONFIG), {
    model: "gemini-3.1-pro-high",
    effort: "high",
  });
});

test("returns null for an unknown agy tier", () => {
  assert.equal(agyConfigForTier("unknown", DEFAULT_MODEL_CONFIG), null);
});

test("applies agy model and effort for a tier", () => {
  const args = applyAgyTier(
    ["-p", "fix the bug"],
    "strong",
    DEFAULT_MODEL_CONFIG,
  );

  assert.deepEqual(args, [
    "--model",
    "gemini-3.8-flash-high",
    "--effort",
    "high",
    "-p",
    "fix the bug",
  ]);
});

test("keeps an explicit agy model chosen by the user", () => {
  const args = applyAgyTier(
    ["--model", "gemini-3.1-pro-high", "-p", "fix the bug"],
    "fast",
    DEFAULT_MODEL_CONFIG,
  );

  assert.equal(args.includes("gemini-3.8-flash-low"), false);

  assert.equal(args.includes("gemini-3.1-pro-high"), true);
});

test("keeps an explicit agy effort chosen by the user", () => {
  const args = applyAgyTier(
    ["--effort", "medium", "-p", "fix the bug"],
    "fast",
    DEFAULT_MODEL_CONFIG,
  );

  assert.equal(args.includes("medium"), true);

  assert.equal(args.includes("gemini-3.8-flash-medium"), true);
});

test("reads the prompt from agy arguments", () => {
  assert.equal(promptFromAgyArgs(["-p", "Fix the bug"]), "Fix the bug");

  assert.equal(
    promptFromAgyArgs(["--print", "Review the component"]),
    "Review the component",
  );

  assert.equal(promptFromAgyArgs(["--prompt=Run the tests"]), "Run the tests");
});

test("returns null when agy has no print prompt", () => {
  assert.equal(promptFromAgyArgs(["models"]), null);
});

test("detects an explicit agy model", () => {
  assert.equal(
    hasExplicitAgyModel([
      "--model",
      "gemini-3.1-pro-high",
      "-p",
      "test prompt",
    ]),
    true,
  );

  assert.equal(hasExplicitAgyModel(["-p", "test prompt"]), false);
});

test("builds the agy model slug from model family and effort", () => {
  assert.equal(agyModelSlug("gemini-3.8-flash", "low"), "gemini-3.8-flash-low");

  assert.equal(
    agyModelSlug("gemini-3.8-flash", "medium"),
    "gemini-3.8-flash-medium",
  );

  assert.equal(
    agyModelSlug("gemini-3.8-flash", "high"),
    "gemini-3.8-flash-high",
  );

  assert.equal(agyModelSlug("gemini-3.1-pro", "high"), "gemini-3.1-pro-high");
  assert.throws(() => agyModelSlug("claude-opus-5", "high"), /unsupported Agy/);
  assert.throws(() => agyModelSlug("gemini-3.1-pro", "low"), /unsupported Agy/);
});

test("prefers a shell-free Windows executable over a batch shim on PATH", () => {
  const first = mkdtempSync(join(tmpdir(), "agy-cmd-"));
  const second = mkdtempSync(join(tmpdir(), "agy-exe-"));
  try {
    writeFileSync(join(first, "agy.cmd"), "");
    writeFileSync(join(second, "agy.exe"), "");
    assert.equal(resolveAgy(`${first};${second}`, "win32"), join(second, "agy.exe"));
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("explicit model bypasses Jev and preserves native Agy arguments", async () => {
  let calls = 0;
  let launched;
  await runAgy(["--model", "gemini-3.1-pro-high", "-p", "fix"], {
    config: DEFAULT_MODEL_CONFIG,
    executable: "agy-fixture",
    env: { JEV_API_KEY: "test" },
    loadEnv() {},
    route() { calls += 1; },
    spawnProcess(_file, args) { launched = args; return new EventEmitter(); },
  });
  assert.equal(calls, 0);
  assert.deepEqual(launched, ["--model", "gemini-3.1-pro-high", "-p", "fix"]);
});

test("explicit effort matches the launched model and routing message", async () => {
  let launched;
  let message = "";
  await runAgy(["--effort", "medium", "-p", "fix"], {
    config: DEFAULT_MODEL_CONFIG,
    executable: "agy-fixture",
    env: { JEV_API_KEY: "test" },
    loadEnv() {},
    route: ({ config, effortOverride }) => ({
      ...agyConfigForTier("strong", config, effortOverride), tier: "strong", reason: "jev",
    }),
    spawnProcess(_file, args) { launched = args; return new EventEmitter(); },
    stderr: { write(value) { message += value; } },
  });
  assert.deepEqual(launched.slice(0, 4), ["--model", "gemini-3.8-flash-medium", "--effort", "medium"]);
  assert.deepEqual(launched.slice(4), ["-p", "fix"]);
  assert.match(message, /gemini-3\.8-flash-medium \(effort medium, jev\)/);
});

test("real routing with explicit effort drives one displayed and launched spec", async () => {
  let launched;
  let message = "";
  let candidateIds;
  const fakeJev = async ({ models }) => {
    candidateIds = models.map(({ id }) => id);
    return { choice: "gemini-3.8-flash-medium", confidence: 0.95 };
  };
  await runAgy(["--effort=medium", "--prompt", "fix a bug"], {
    config: DEFAULT_MODEL_CONFIG,
    executable: "agy.exe",
    env: { JEV_API_KEY: "test" },
    loadEnv() {},
    route: (input) => routeAgyTier({ ...input, route: fakeJev }),
    spawnProcess(_file, args, options) { launched = { args, options }; return new EventEmitter(); },
    stderr: { write(value) { message += value; } },
  });
  assert.deepEqual(candidateIds, ["gemini-3.8-flash-medium"]);
  assert.deepEqual(launched.args, ["--model", "gemini-3.8-flash-medium", "--effort", "medium", "--prompt", "fix a bug"]);
  assert.equal(launched.options.shell, false);
  assert.match(message, /routed this turn to gemini-3\.8-flash-medium \(effort medium, jev\/no-change\)/);
});

test("normal print routing launches the Jev-selected Gemini tier", async () => {
  let launched;
  await runAgy(["-p", "simple task"], {
    config: DEFAULT_MODEL_CONFIG,
    executable: "agy.exe",
    env: { JEV_API_KEY: "test" },
    loadEnv() {},
    route: (input) => routeAgyTier({ ...input, route: async () => ({ choice: "gemini-3.8-flash-low", confidence: 0.95 }) }),
    spawnProcess(_file, args) { launched = args; return new EventEmitter(); },
    stderr: { write() {} },
  });
  assert.deepEqual(launched, ["--model", "gemini-3.8-flash-low", "--effort", "low", "-p", "simple task"]);
});

test("rejects repeated effort and missing routing values before launch", async () => {
  for (const args of [
    ["--effort", "high", "--effort", "medium", "-p", "fix"],
    ["--effort", "-p", "fix"],
    ["--model=", "-p", "fix"],
    ["--prompt", "--effort", "high"],
  ]) {
    let launched = false;
    let errors = "";
    process.exitCode = undefined;
    await runAgy(args, {
      config: DEFAULT_MODEL_CONFIG,
      executable: "agy.exe",
      env: { JEV_API_KEY: "test" },
      loadEnv() {},
      spawnProcess() { launched = true; return new EventEmitter(); },
      stderr: { write(value) { errors += value; } },
    });
    assert.equal(launched, false);
    assert.match(errors, /requires a non-empty value|repeated/);
    assert.equal(process.exitCode, 1);
  }
  process.exitCode = undefined;
});

test("Windows shell metacharacters remain literal arguments with no shell", async () => {
  const prompt = "fix & | > < ^ this";
  let launched;
  let received = "";
  let childFinished;
  await runAgy(["--prompt", prompt], {
    config: DEFAULT_MODEL_CONFIG,
    executable: "C:\\Tools\\agy.exe",
    env: { JEV_API_KEY: "test" },
    loadEnv() {},
    route: (input) => routeAgyTier({ ...input, route: async () => ({ choice: "gemini-3.8-flash-high", confidence: 0.95 }) }),
    spawnProcess(file, args, options) {
      launched = { file, args, options };
      const child = spawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args], {
        ...options, stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => { received += chunk; });
      childFinished = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
      });
      return child;
    },
    stderr: { write() {} },
  });
  await childFinished;
  assert.equal(launched.file, "C:\\Tools\\agy.exe");
  assert.equal(launched.args.at(-1), prompt);
  assert.equal(launched.options.shell, false);
  assert.deepEqual(JSON.parse(received), launched.args);
});

test("batch-only Agy path fails closed without spawning a shell", async () => {
  for (const extension of ["cmd", "bat"]) {
    let launched = false;
    let errors = "";
    await runAgy(["--prompt", "fix & | > < ^"], {
      config: DEFAULT_MODEL_CONFIG,
      executable: `C:\\Tools\\agy.${extension}`,
      env: {},
      loadEnv() {},
      spawnProcess() { launched = true; return new EventEmitter(); },
      stderr: { write(value) { errors += value; } },
    });
    assert.equal(launched, false);
    assert.match(errors, /install or select agy\.exe/);
  }
  process.exitCode = undefined;
});

test("parser does not treat a value after -- as a routing option", () => {
  assert.deepEqual(parseAgyArgs(["--prompt=--model", "--", "--effort", "high"]), {
    prompt: "--model", explicitModel: null, explicitEffort: null,
    passthroughArgs: ["--prompt=--model", "--", "--effort", "high"],
  });
});
