import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envFilePath,
  hasJevApiKey,
  loadJevEnv,
  writeJevApiKey,
} from "../src/env.mjs";

test("builds the default Jev env file path", () => {
  assert.equal(
    envFilePath("C:\\Users\\Ahmad"),
    join("C:\\Users\\Ahmad", ".jev-router.env"),
  );
});

test("loads Jev environment values from a file", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-env-"));

  const path = join(directory, ".jev-router.env");

  writeFileSync(
    path,
    ["JEV_API_KEY=test-key", "TYPESAFE_API_KEY='test-typesafe-key'", ""].join(
      "\n",
    ),
    "utf8",
  );

  const env = {};

  try {
    loadJevEnv(path, env);

    assert.equal(env.JEV_API_KEY, "test-key");

    assert.equal(env.TYPESAFE_API_KEY, "test-typesafe-key");
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("does not overwrite existing environment values", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-env-"));

  const path = join(directory, ".jev-router.env");

  writeFileSync(path, "JEV_API_KEY=file-key\n", "utf8");

  const env = {
    JEV_API_KEY: "existing-key",
  };

  try {
    loadJevEnv(path, env);

    assert.equal(env.JEV_API_KEY, "existing-key");
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("writes a Jev API key to an env file", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-env-"));

  const path = join(directory, ".jev-router.env");

  try {
    writeJevApiKey("test-secret-key", path);

    const env = {};

    loadJevEnv(path, env);

    assert.equal(env.JEV_API_KEY, "test-secret-key");
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("reports whether a Jev API key is configured", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-env-"));

  const path = join(directory, ".jev-router.env");

  try {
    assert.equal(hasJevApiKey(path, {}), false);

    writeJevApiKey("configured-key", path);

    assert.equal(hasJevApiKey(path, {}), true);
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("rejects an empty Jev API key", () => {
  assert.throws(() => writeJevApiKey("   "), /cannot be empty/);
});

test("updates only the existing key while preserving comments and other variables", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-env-"));
  const path = join(directory, ".jev-router.env");
  const original = "# account settings\r\nOTHER=value\r\n\r\nJEV_API_KEY=old-key\r\nLAST=kept\r\n";

  try {
    writeFileSync(path, original, "utf8");
    writeJevApiKey("new-key", path);
    assert.equal(
      readFileSync(path, "utf8"),
      "# account settings\r\nOTHER=value\r\n\r\nJEV_API_KEY=new-key\r\nLAST=kept\r\n",
    );
    assert.equal(readFileSync(path, "utf8").match(/JEV_API_KEY=/g)?.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("appends a key safely when the env file has no final newline", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-env-"));
  const path = join(directory, ".jev-router.env");

  try {
    writeFileSync(path, "# comment\nOTHER=value", "utf8");
    writeJevApiKey("new-key", path);
    assert.equal(readFileSync(path, "utf8"), "# comment\nOTHER=value\nJEV_API_KEY=new-key\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("collapses duplicate existing key entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-env-"));
  const path = join(directory, ".jev-router.env");

  try {
    writeFileSync(path, "JEV_API_KEY=first\n# keep\nJEV_API_KEY=second\nOTHER=value\n", "utf8");
    writeJevApiKey("new-key", path);
    assert.equal(readFileSync(path, "utf8"), "JEV_API_KEY=new-key\n# keep\nOTHER=value\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects newline injection without changing the env file", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-env-"));
  const path = join(directory, ".jev-router.env");

  try {
    writeFileSync(path, "OTHER=value\n", "utf8");
    assert.throws(() => writeJevApiKey("safe\nINJECTED=yes", path), /newline/i);
    assert.throws(() => writeJevApiKey("safe\rINJECTED=yes", path), /newline/i);
    assert.equal(readFileSync(path, "utf8"), "OTHER=value\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
