import { spawn } from "node:child_process";
import { createAgyEventParser, validateAgyResult } from "./agy-protocol.mjs";
import { isSupportedAgyEffort, isValidAgyLaunchSpec } from "./agy-models.mjs";
import { routeAgyTier } from "./agy-routing.mjs";
import { TIER_NAMES } from "./core/tiers.mjs";
import { loadUserConfig } from "./user-config.mjs";

// A runner's completed promise must settle only after its child is terminal/reaped.
// The session below depends on run(), not spawn().
export function createAgyChildRunner({ executable, spawnProcess = spawn, env = process.env }) {
  if (!executable || /\.(cmd|bat)$/i.test(executable)) {
    throw new Error("a directly executable Agy binary is required");
  }
  return {
    run(spec, { onStdout, onStderr }) {
      const child = spawnProcess(executable, spec.args, {
        stdio: ["ignore", "pipe", "pipe"], shell: false, env,
      });
      const completed = new Promise((resolve) => {
        let processError = null;
        const onError = (error) => { processError = error; };
        const onClose = (code, signal) => {
          child.removeListener("error", onError);
          child.stdout?.removeListener("data", onStdout);
          child.stderr?.removeListener("data", onStderr);
          resolve({ code, signal, error: processError });
        };
        child.on("error", onError);
        child.once("close", onClose);
      });
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      return { completed, cancel: () => child.kill() };
    },
  };
}

function launchSpec({ prompt, model, effort, conversationId }) {
  if (!isValidAgyLaunchSpec({ model, effort })) {
    throw new Error("unsupported Agy model or effort");
  }
  const args = ["--model", model, "--effort", effort, "--output-format", "stream-json"];
  if (conversationId !== null) args.push("--conversation", conversationId);
  args.push("-p", prompt);
  return Object.freeze({ prompt, model, effort, conversationId, args: Object.freeze(args) });
}

export function createAgySession({
  runner,
  route = routeAgyTier,
  config = loadUserConfig(),
  currentTier = "strong",
  onEvent = () => {},
  onAgentText = () => {},
  onStep = () => {},
  onResult = () => {},
  onDiagnostic = () => {},
  onLaunch = () => {},
} = {}) {
  if (!runner || typeof runner.run !== "function") throw new Error("Agy session requires a child runner");
  if (!TIER_NAMES.includes(currentTier)) throw new Error("invalid Agy tier");

  let conversationId = null;
  let numTurns = 0;
  let tier = currentTier;
  let model = null;
  let effort = null;
  let manual = null;
  let active = null;
  let recoveryRequired = false;

  function state() {
    return Object.freeze({
      conversationId, numTurns, tier, model, effort,
      mode: manual ? "manual" : "automatic",
      active: active !== null, recoveryRequired,
    });
  }

  function requireIdle() {
    if (active) throw new Error("an Agy turn is already active");
  }

  function fail(status, error, spec, semantic = null) {
    recoveryRequired = true;
    return { ok: false, status, error, spec, semantic, uncertain: true };
  }

  function requestCancel(turn) {
    if (!turn.child || turn.cancelAttempted) return;
    turn.cancelAttempted = true;
    try {
      if (turn.child.cancel() !== true) turn.cancelError = "Agy child cancellation was not confirmed";
    } catch (error) {
      turn.cancelError = String(error?.message ?? error);
    }
  }

  return {
    getState: state,
    setManualModel(nextModel, nextEffort) {
      requireIdle();
      if (!isValidAgyLaunchSpec({ model: nextModel, effort: nextEffort })) {
        throw new Error("unsupported manual Agy model or effort");
      }
      manual = Object.freeze({ model: nextModel, effort: nextEffort });
    },
    setAutomaticMode() {
      requireIdle();
      manual = null;
    },
    acknowledgeRecovery() {
      requireIdle();
      recoveryRequired = false;
    },
    cancelCurrentTurn() {
      if (!active || active.cancelRequested) return false;
      active.cancelRequested = true;
      requestCancel(active);
      return true;
    },
    async runTurn(prompt, { effortOverride = null } = {}) {
      requireIdle();
      if (recoveryRequired) throw new Error("Agy turn outcome is uncertain; acknowledge recovery before continuing");
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Agy turn requires a prompt");
      if (effortOverride !== null && !isSupportedAgyEffort(effortOverride)) {
        throw new Error("unsupported Agy effort");
      }
      if (manual && effortOverride !== null) {
        throw new Error("effort override conflicts with manual Agy model");
      }
      const turn = { child: null, cancelRequested: false, cancelAttempted: false, cancelError: null };
      active = turn; // lock before awaiting Jev
      let spec = null;
      let started = false;
      let outcome;
      const executeTurn = async () => {
        const selected = manual ?? await route({
          prompt, currentTier: tier, config, effortOverride,
        });
        if (turn.cancelRequested) {
          return fail("CANCELED", "turn canceled before launch", spec);
        }
        if (!manual && !TIER_NAMES.includes(selected?.tier)) {
          throw new Error("routing returned an invalid Agy tier");
        }
        if (effortOverride !== null && selected.effort !== effortOverride) {
          throw new Error("routing returned an effort different from the override");
        }
        spec = launchSpec({
          prompt, model: selected.model, effort: selected.effort, conversationId,
        });
        onLaunch(structuredClone(spec));
        const parser = createAgyEventParser();
        let terminal = null;
        let initId = null;
        let streamError = null;
        let callbackError = null;
        const deliver = (name, callback, value) => {
          try {
            callback(value);
            return true;
          } catch (error) {
            callbackError = { callback: name, message: String(error?.message ?? error) };
            requestCancel(turn);
            return false;
          }
        };
        const onStdout = (chunk) => {
          if (streamError || callbackError || turn.cancelRequested) return;
          try {
            for (const event of parser.push(chunk)) {
              if (terminal) throw new Error("event after terminal Agy result");
              if (!deliver("onEvent", onEvent, structuredClone(event)) || turn.cancelRequested) break;
              if (event.event === "init") {
                if (event.init.model && event.init.model !== spec.model) {
                  throw new Error("Agy init model does not match launch model");
                }
                if (event.conversation_id) {
                  initId = event.conversation_id;
                  if (spec.conversationId && initId !== spec.conversationId) {
                    throw new Error("Agy init conversation_id does not match resumed conversation");
                  }
                }
              }
              if (event.event === "step_update") {
                if (!deliver("onStep", onStep, structuredClone(event.step_update)) || turn.cancelRequested) break;
                if (event.step_update.step_type === "agent_response"
                  && typeof event.step_update.text_delta === "string") {
                  if (!deliver("onAgentText", onAgentText, event.step_update.text_delta)) break;
                }
              }
              if (event.event === "result") terminal = event;
            }
          } catch (error) {
            streamError = error;
            requestCancel(turn);
          }
        };
        turn.child = runner.run(spec, {
          onStdout,
          onStderr: (chunk) => {
            if (!callbackError && !turn.cancelRequested) deliver("onDiagnostic", onDiagnostic, String(chunk));
          },
        });
        started = true;
        if (turn.cancelRequested || streamError || callbackError) requestCancel(turn);
        const exit = await turn.child.completed;
        if (!streamError && !callbackError && !turn.cancelRequested) {
          try { parser.finish(); } catch (error) { streamError = error; }
        }
        if (turn.cancelRequested) {
          outcome = fail("CANCELED", "turn canceled; Agy conversation state may have changed", spec);
        } else if (callbackError) {
          outcome = { ...fail("CALLBACK_ERROR", callbackError.message, spec), callbackError };
        } else if (streamError) {
          outcome = fail("PROTOCOL_ERROR", streamError.message, spec);
        } else if (exit.error) {
          outcome = fail("PROCESS_ERROR", String(exit.error?.message ?? exit.error), spec);
        } else if (!terminal) {
          outcome = fail("PROTOCOL_ERROR", "Agy child exited without a terminal result", spec);
        } else {
          let semantic;
          try {
            semantic = validateAgyResult(terminal, {
              expectedConversationId: spec.conversationId ?? undefined,
            });
          } catch (error) {
            outcome = fail("PROTOCOL_ERROR", error.message, spec);
          }
          if (!outcome && !semantic.ok) {
            outcome = fail(semantic.status, semantic.error ?? "Agy turn did not succeed", spec, semantic);
          }
          if (!outcome && initId && semantic.conversationId !== initId) {
            outcome = fail("PROTOCOL_ERROR", "Agy result conversation_id differs from init", spec, semantic);
          }
          if (!outcome && spec.conversationId && semantic.numTurns <= numTurns) {
            outcome = fail("PROTOCOL_ERROR", "Agy result num_turns did not advance", spec, semantic);
          }
          if (!outcome && exit.code !== 0) {
            outcome = fail("EXIT_ERROR", `Agy exited with code ${exit.code ?? "null"}`, spec, semantic);
          }
          if (!outcome) {
            conversationId = semantic.conversationId;
            numTurns = semantic.numTurns;
            tier = selected.tier ?? tier;
            model = spec.model;
            effort = spec.effort;
            outcome = { ok: true, status: "SUCCESS", spec, semantic, uncertain: false };
          }
        }
        return outcome;
      };
      try {
        outcome = await executeTurn();
      } catch (error) {
        outcome = fail(started ? "PROCESS_ERROR" : "LAUNCH_ERROR", String(error?.message ?? error), spec);
      } finally {
        active = null;
      }
      if (turn.cancelError) outcome = { ...outcome, cancelError: turn.cancelError };
      // Result delivery is observational: a renderer failure cannot undo verified state.
      try {
        onResult(structuredClone(outcome));
      } catch (error) {
        outcome = {
          ...outcome,
          resultCallbackError: { callback: "onResult", message: String(error?.message ?? error) },
        };
      }
      return outcome;
    },
  };
}
