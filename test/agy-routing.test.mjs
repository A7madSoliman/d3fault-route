import assert from "node:assert/strict";
import test from "node:test";

import { routeAgyTier } from "../src/agy-routing.mjs";
import { DEFAULT_MODEL_CONFIG } from "../src/default-config.mjs";
import { readFileSync } from "node:fs";

test("Agy routing imports the model adapter without importing the CLI", () => {
  const source = readFileSync(new URL("../src/agy-routing.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\/agy-models\.mjs"/);
  assert.doesNotMatch(source, /agy-cli\.mjs/);
  assert.doesNotMatch(source, /haiku|sonnet|opus|fable|AGY_TO_CORE|CORE_TO_AGY/);
});

test("routes an agy task to the Jev-selected Gemini model", async () => {
  const fakeJev = async () => ({
    choice: "gemini-3.8-flash-high",
    confidence: 0.95,
  });

  const result = await routeAgyTier({
    prompt: "Fix a difficult multi-file bug",
    route: fakeJev,
    config: DEFAULT_MODEL_CONFIG,
  });

  assert.deepEqual(result, {
    tier: "strong",
    model: "gemini-3.8-flash-high",
    effort: "high",
    confidence: 0.95,
    reason: "jev/no-change",
  });
});

test("Jev candidates and final selection contain supported Gemini models only", async () => {
  const config = structuredClone(DEFAULT_MODEL_CONFIG);
  config.agy.fast.model = "claude-opus-5";
  config.agy.balanced.model = "gpt-6-sol";
  config.agy.strong.model = "gpt-oss-120b";
  const result = await routeAgyTier({
    prompt: "Fix a difficult bug",
    config,
    route: async ({ current, models }) => {
      assert.match(current, /^gemini-/);
      assert.equal(models.length, 4);
      assert.ok(models.every(({ id }) => /^gemini-(3\.8-flash-(low|medium|high)|3\.1-pro-high)$/.test(id)));
      return { choice: models[0].id, confidence: 0.95 };
    },
  });
  assert.match(result.model, /^gemini-/);
});

test("explicit effort changes candidates and the final selected model", async () => {
  const result = await routeAgyTier({
    prompt: "Fix a difficult bug",
    config: DEFAULT_MODEL_CONFIG,
    effortOverride: "medium",
    route: async ({ models }) => {
      assert.deepEqual(models.map(({ id }) => id), ["gemini-3.8-flash-medium"]);
      return { choice: "gemini-3.8-flash-medium", confidence: 0.95 };
    },
  });
  assert.equal(result.model, "gemini-3.8-flash-medium");
  assert.equal(result.effort, "medium");
});

test("Agy sends canonical tiers to Jev without a Claude alias layer", async () => {
  const result = await routeAgyTier({
    prompt: "simple task",
    config: DEFAULT_MODEL_CONFIG,
    route: async ({ models }) => {
      assert.deepEqual(models.map(({ tier }) => tier), ["strong", "fast", "balanced", "long"]);
      return { choice: "gemini-3.8-flash-low", confidence: 0.95 };
    },
  });
  assert.equal(result.tier, "fast");
  assert.equal(result.model, "gemini-3.8-flash-low");
});

test("Agy preserves a legacy prompt alias while deciding in canonical tiers", async () => {
  const result = await routeAgyTier({
    prompt: "use haiku for this typo",
    config: DEFAULT_MODEL_CONFIG,
    route: async () => ({ choice: "gemini-3.8-flash-high", confidence: 0.95 }),
  });
  assert.equal(result.tier, "fast");
  assert.equal(result.model, "gemini-3.8-flash-low");
  assert.equal(result.reason, "override");
});
