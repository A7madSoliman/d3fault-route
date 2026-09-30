import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_CONFIG } from "../src/default-config.mjs";
import {
  loadUserConfig,
  resetUserConfig,
  updateUserConfig,
} from "../src/user-config.mjs";

function withConfig(config, run) {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-test-"));

  const path = join(directory, "config.json");

  writeFileSync(path, JSON.stringify(config), "utf8");

  try {
    run(loadUserConfig(path));
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
}

test("keeps the default effort when only the model changes", () => {
  withConfig(
    {
      agy: {
        strong: {
          model: "gemini-3.1-pro",
        },
      },
    },
    (config) => {
      assert.deepEqual(config.agy.strong, {
        model: "gemini-3.1-pro",
        effort: "high",
      });
    },
  );
});

test("keeps the default model when only the effort changes", () => {
  withConfig(
    {
      agy: {
        strong: {
          effort: "medium",
        },
      },
    },
    (config) => {
      assert.deepEqual(config.agy.strong, {
        model: "gemini-3.8-flash",
        effort: "medium",
      });
    },
  );
});

test("allows model and effort to change together", () => {
  withConfig(
    {
      agy: {
        strong: {
          model: "gemini-3.1-pro",
          effort: "high",
        },
      },
    },
    (config) => {
      assert.deepEqual(config.agy.strong, {
        model: "gemini-3.1-pro",
        effort: "high",
      });
    },
  );
});

test("leaves untouched tiers on their defaults", () => {
  withConfig(
    {
      agy: {
        strong: {
          effort: "medium",
        },
      },
    },
    (config) => {
      assert.deepEqual(config.agy.fast, {
        model: "gemini-3.8-flash",
        effort: "low",
      });

      assert.deepEqual(config.agy.balanced, {
        model: "gemini-3.8-flash",
        effort: "medium",
      });
    },
  );
});

test("updates only the requested user config values", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-test-"));

  const path = join(directory, "config.json");

  try {
    updateUserConfig({
      provider: "agy",
      tier: "strong",
      values: {
        effort: "medium",
      },
      path,
    });

    const config = loadUserConfig(path);

    assert.deepEqual(config.agy.strong, {
      model: "gemini-3.8-flash",
      effort: "medium",
    });

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

test("resets only the requested user config tier", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-test-"));

  const path = join(directory, "config.json");

  try {
    updateUserConfig({
      provider: "agy",
      tier: "fast",
      values: {
        model: "gemini-3.1-pro",
        effort: "high",
      },
      path,
    });

    updateUserConfig({
      provider: "agy",
      tier: "strong",
      values: {
        effort: "medium",
      },
      path,
    });

    resetUserConfig({
      provider: "agy",
      tier: "fast",
      path,
    });

    const config = loadUserConfig(path);

    assert.deepEqual(config.agy.fast, {
      model: "gemini-3.8-flash",
      effort: "low",
    });

    assert.deepEqual(config.agy.strong, {
      model: "gemini-3.8-flash",
      effort: "medium",
    });
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

for (const model of ["claude-opus-5", "gpt-6-sol", "gpt-oss-120b", "arbitrary-model"]) {
  test(`rejects ${model} during Agy config mutation and ignores it on load`, () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-router-test-"));
    const path = join(directory, "config.json");
    try {
      assert.throws(() => updateUserConfig({ provider: "agy", tier: "strong", values: { model }, path }), /unsupported Agy/);
      writeFileSync(path, JSON.stringify({ agy: { strong: { model } } }), "utf8");
      assert.deepEqual(loadUserConfig(path).agy.strong, DEFAULT_MODEL_CONFIG.agy.strong);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("rejects an unsupported Agy family and effort combination", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-router-test-"));
  try {
    assert.throws(() => updateUserConfig({ provider: "agy", tier: "long", values: { effort: "low" }, path: join(directory, "config.json") }), /unsupported Agy/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const malformed of ["{invalid", "[]", "null", '{"agy":[]}', '{"agy":{"fast":null}}']) {
  test(`set and reset preserve malformed config: ${malformed}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-router-test-"));
    const path = join(directory, "config.json");

    try {
      writeFileSync(path, malformed, "utf8");
      assert.throws(
        () => updateUserConfig({ provider: "agy", tier: "fast", values: { effort: "medium" }, path }),
        /config.*invalid.*fix|config.*invalid.*restore/i,
      );
      assert.throws(
        () => resetUserConfig({ provider: "agy", tier: "fast", path }),
        /config.*invalid.*fix|config.*invalid.*restore/i,
      );
      assert.equal(readFileSync(path, "utf8"), malformed);
      assert.deepEqual(loadUserConfig(path).agy.fast, {
        model: "gemini-3.8-flash",
        effort: "low",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
