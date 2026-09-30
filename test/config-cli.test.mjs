import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasJevApiKey } from "../src/env.mjs";
import {
  formatConfig,
  parseSetArgs,
  runConfigCli,
} from "../src/config-cli.mjs";

import { loadUserConfig } from "../src/user-config.mjs";

test("formats the unified config for all providers", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-config-cli-"));
  let output;
  try {
    output = formatConfig(join(directory, "config.json"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  assert.match(output, /AGY/);
  assert.match(output, /CODEX/);
  assert.match(output, /CLAUDE/);

  assert.match(output, /fast/);
  assert.match(output, /balanced/);
  assert.match(output, /strong/);
  assert.match(output, /long/);
});

for (const command of ["set", "reset"]) {
  test(`jev-config ${command} reports malformed config without overwriting it`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-router-config-cli-"));
    const path = join(directory, "config.json");
    const original = "{bad-json";
    let output = "";
    let errors = "";
    const args = command === "set"
      ? ["set", "agy", "fast", "--effort", "medium"]
      : ["reset", "agy", "fast"];

    try {
      writeFileSync(path, original, "utf8");
      await runConfigCli(args, {
        path,
        stdout: { write(value) { output += value; } },
        stderr: { write(value) { errors += value; } },
      });
      assert.equal(readFileSync(path, "utf8"), original);
      assert.match(errors, /config.*invalid.*fix or restore/i);
      assert.equal(output, "");
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("parses model and effort updates", () => {
  assert.deepEqual(
    parseSetArgs([
      "agy",
      "strong",
      "--model",
      "gemini-4.0-flash",
      "--effort",
      "medium",
    ]),
    {
      provider: "agy",
      tier: "strong",
      values: {
        model: "gemini-4.0-flash",
        effort: "medium",
      },
    },
  );
});

test("jev-config set updates a temporary config", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-config-cli-"));

  const path = join(directory, "config.json");

  let output = "";

  const stdout = {
    write(value) {
      output += value;
    },
  };

  const stderr = {
    write() {},
  };

  try {
    runConfigCli(["set", "agy", "strong", "--effort", "medium"], {
      path,
      stdout,
      stderr,
    });

    const config = loadUserConfig(path);

    assert.equal(config.agy.strong.model, "gemini-3.8-flash");

    assert.equal(config.agy.strong.effort, "medium");

    assert.match(output, /updated agy\.strong/);
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("jev-config reset restores the default tier config", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-config-cli-"));

  const path = join(directory, "config.json");

  const stdout = {
    write() {},
  };

  const stderr = {
    write() {},
  };

  try {
    runConfigCli(
      [
        "set",
        "agy",
        "fast",
        "--model",
        "gemini-3.1-pro",
        "--effort",
        "high",
      ],
      {
        path,
        stdout,
        stderr,
      },
    );

    runConfigCli(["reset", "agy", "fast"], {
      path,
      stdout,
      stderr,
    });

    const config = loadUserConfig(path);

    assert.deepEqual(config.agy.fast, {
      model: "gemini-3.8-flash",
      effort: "low",
    });
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("jev-config key status reports configured state", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-config-cli-"));

  const envPath = join(directory, ".jev-router.env");

  let output = "";

  const stdout = {
    write(value) {
      output += value;
    },
  };

  const stderr = {
    write() {},
  };

  try {
    runConfigCli(["key", "status"], {
      envPath,
      stdout,
      stderr,
    });

    assert.match(output, /not configured/);
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("jev-config key set saves the API key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-config-cli-"));

  const envPath = join(directory, ".jev-router.env");

  let output = "";

  const stdout = {
    write(value) {
      output += value;
    },
  };

  const stderr = {
    write() {},
  };

  const readSecret = async () => "test-secret-key";

  try {
    await runConfigCli(["key", "set"], {
      envPath,
      stdout,
      stderr,
      readSecret,
    });

    assert.equal(hasJevApiKey(envPath, {}), true);

    assert.match(output, /API key: saved/);

    assert.equal(output.includes("test-secret-key"), false);
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("jev-config key set rejects injected newlines without printing the secret", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-config-cli-"));
  const envPath = join(directory, ".jev-router.env");
  let output = "";
  let errors = "";

  try {
    writeFileSync(envPath, "OTHER=value\n", "utf8");
    await runConfigCli(["key", "set"], {
      envPath,
      stdout: { write(value) { output += value; } },
      stderr: { write(value) { errors += value; } },
      readSecret: async () => "secret\nINJECTED=yes",
    });
    assert.equal(readFileSync(envPath, "utf8"), "OTHER=value\n");
    assert.match(errors, /single line/);
    assert.equal((output + errors).includes("secret"), false);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = undefined;
    rmSync(directory, { recursive: true, force: true });
  }
});
