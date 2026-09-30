// Claude model IDs and capability handling stay at the provider boundary.
import { availableTiers as coreAvailableTiers } from "./core/tiers.mjs";

export { TIERS, idOf, tierSpec, tierOf } from "./claude-models.mjs";

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "jev-router";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/**
 * Fable bills extra usage credits, so it is opt-in. Everything else is covered by a normal
 * subscription.
 */
export const availableTiers = () =>
  coreAvailableTiers(process.env.JEV_ALLOW_FABLE === "1");

export const CLAUDE_TIER_ALIASES = {
  fast: ["haiku", "luna"], balanced: ["sonnet", "terra"],
  strong: ["opus", "sol"], long: ["fable", "astra"],
};
