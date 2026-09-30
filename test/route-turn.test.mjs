import test from "node:test";
import assert from "node:assert/strict";
import { modelForTier, routeTurn } from "../src/core/route-turn.mjs";

const candidates = [
  { id: "small.v1", tier: "fast", description: "small" },
  { id: "middle.v1", tier: "balanced", description: "middle" },
  { id: "large.v1", tier: "strong", description: "large" },
  { id: "large.v2", tier: "strong", description: "new large" },
  { id: "huge.v1", tier: "long", description: "huge" },
];
const base = {
  prompt: "Fix this task",
  currentModel: "large.v1",
  currentTier: "strong",
  contextTokens: 0,
  candidates,
  availableTiers: ["fast", "balanced", "strong"],
  preferredModels: { fast: "small.v1", balanced: "middle.v1", strong: "large.v1", long: "huge.v1" },
};
const choose = (choice, confidence = 0.95) => async () => ({ choice, confidence });

test("keeps Jev's exact available model, including a second version in the same tier", async () => {
  const result = await routeTurn({ ...base, route: choose("large.v2") });
  assert.deepEqual({ tier: result.tier, model: result.model, reason: result.reason },
    { tier: "strong", model: "large.v2", reason: "jev/no-change" });
  assert.equal(result.confidence, 0.95);
});

test("low confidence preserves downgrades and caps upgrades", async () => {
  const downgrade = await routeTurn({ ...base, route: choose("small.v1", 0.2) });
  assert.equal(downgrade.model, "large.v1");
  assert.match(downgrade.reason, /low-confidence-no-downgrade/);
  const upgrade = await routeTurn({ ...base, currentModel: "small.v1", currentTier: "fast",
    availableTiers: ["fast", "balanced", "strong", "long"], route: choose("huge.v1", 0.2) });
  assert.equal(upgrade.tier, "balanced");
  assert.equal(upgrade.model, "middle.v1");
});

test("Jev failure and unavailable exact choices keep a valid current candidate", async () => {
  const failed = await routeTurn({ ...base, route: async () => null });
  assert.equal(failed.model, "large.v1");
  assert.equal(failed.confidence, null);
  assert.match(failed.reason, /jev-unavailable/);
  const unavailable = await routeTurn({ ...base, route: choose("foreign.v1") });
  assert.equal(unavailable.model, "large.v1");
  assert.match(unavailable.reason, /jev-unavailable/);
  const rejected = await routeTurn({ ...base, route: async () => { throw new Error("network down"); } });
  assert.equal(rejected.model, "large.v1");
  assert.match(rejected.reason, /jev-unavailable/);
});

test("canonical availability substitution and explicit prompt override use only candidates", async () => {
  const substituted = await routeTurn({ ...base, candidates: candidates.filter((item) => item.tier !== "balanced"),
    currentModel: "small.v1", currentTier: "fast", override: "balanced", route: choose("small.v1") });
  assert.equal(substituted.tier, "strong");
  assert.equal(substituted.model, "large.v1");
  assert.match(substituted.reason, /override\+unavailable/);
  const override = await routeTurn({ ...base, override: "fast", route: choose("large.v2") });
  assert.equal(override.model, "small.v1");
  assert.equal(override.reason, "override");
});

test("long is offered only when the provider permits it", async () => {
  let offered;
  const without = await routeTurn({ ...base, route: async ({ models }) => {
    offered = models;
    return { choice: "huge.v1", confidence: 0.95 };
  } });
  assert.equal(offered.some((item) => item.tier === "long"), false);
  assert.equal(without.model, "large.v1");
  const enabled = await routeTurn({ ...base, availableTiers: ["fast", "balanced", "strong", "long"],
    route: choose("huge.v1") });
  assert.equal(enabled.model, "huge.v1");
});

test("cache-sensitive downgrade stays on the current model", async () => {
  const result = await routeTurn({ ...base, contextTokens: 80000, route: choose("small.v1") });
  assert.equal(result.model, "large.v1");
  assert.match(result.reason, /downgrade-not-worth-cache-rebuild/);
});

test("generic fallback uses preferred and available versions without model-name assumptions", () => {
  assert.equal(modelForTier(candidates, "strong", { strong: "large.v2" }), "large.v2");
  assert.equal(modelForTier(candidates.filter((item) => item.id !== "large.v2"), "strong", { strong: "large.v2" }), "large.v1");
  assert.equal(modelForTier(candidates, "strong", { strong: "middle.v1" }), "large.v1");
});
