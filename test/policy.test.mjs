import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride } from "../src/policy.mjs";
import { QUESTIONS } from "../src/core/questions.mjs";
import { shouldUseExactModel } from "../src/core/tiers.mjs";
import { readFileSync } from "node:fs";
import { TIER_NAMES, rankOf, availableTiers } from "../src/core/tiers.mjs";

const ALL = ["fast", "balanced", "strong", "long"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.2 });
const base = { prompt: "refactor the parser", current: "balanced", available: ALL, contextTokens: 0 };

test("score rubrics contain only API-valid descriptions", () => {
  for (const question of Object.values(QUESTIONS).filter((q) => q.type === "score")) {
    assert(question.criteria.every((description) => typeof description === "string"));
    assert(question.criteria.length <= 10);
  }
});

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("strong") }), {
    tier: "strong",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use fast to fix this typo", jev: sure("strong") });
  assert.equal(out.tier, "fast");
  assert.equal(out.reason, "override");
});

test("detectOverride only fires on a real instruction", () => {
  assert.equal(detectOverride("switch to strong"), "strong");
  assert.equal(detectOverride("use luna"), null);
  assert.equal(detectOverride("use strong"), "strong");
  assert.equal(detectOverride("the opus of his career"), null);
});

test("core tiers and policy use canonical IDs without provider imports", () => {
  assert.deepEqual(TIER_NAMES, ALL);
  assert.deepEqual(ALL.map(rankOf), [0, 1, 2, 3]);
  assert.deepEqual(availableTiers(), ["fast", "balanced", "strong"]);
  assert.deepEqual(availableTiers(true), ALL);
  assert.equal(decide({ ...base, jev: sure("opus") }).tier, "balanced");
  for (const file of ["../src/core/tiers.mjs", "../src/core/questions.mjs", "../src/core/route-turn.mjs", "../src/policy.mjs", "../src/router.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["'](?:\.\.\/)?(?:config|codex-proxy|proxy|agy-routing)\.mjs["']/);
  }
});

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "balanced");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "balanced");
});

test("never downgrades on a low-confidence answer", () => {
  const out = decide({ ...base, jev: unsure("fast") });
  assert.equal(out.tier, "balanced");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "fast", jev: unsure("long") });
  assert.equal(out.tier, "balanced");
  assert.equal(out.reason, "low-confidence-capped");
});

test("still allows a confident upgrade to fable", () => {
  assert.equal(decide({ ...base, jev: sure("long") }).tier, "long");
});

test("refuses a downgrade once the cache rebuild costs more than it saves", () => {
  const out = decide({ ...base, current: "strong", jev: sure("fast"), contextTokens: 80000 });
  assert.equal(out.tier, "strong");
  assert.match(out.reason, /cache-rebuild/);
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "strong", jev: sure("fast") }).tier, "fast");
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "fast", available: ["fast", "strong"], jev: sure("balanced") });
  assert.equal(out.tier, "strong");
  assert.match(out.reason, /unavailable/);
});

test("never substitutes upward into paid fable", () => {
  const out = decide({ ...base, current: "fast", available: ["fast", "long"], jev: sure("strong") });
  assert.equal(out.tier, "fast");
});

test("accepts exact model changes within the same tier", () => {
  assert.equal(shouldUseExactModel("jev/no-change", "strong", "strong"), true);
  assert.equal(shouldUseExactModel("low-confidence-no-downgrade/no-change", "strong", "strong"), false);
});
