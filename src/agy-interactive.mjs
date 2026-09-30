import { createInterface } from "node:readline";
import { createAgySession } from "./agy-session.mjs";
import { isValidAgyLaunchSpec } from "./agy-models.mjs";

const COMMAND_HELP = "Commands: /help, /auto, /model <Gemini model slug>, /exit\n";

function manualEffort(model) {
  const effort = model.slice(model.lastIndexOf("-") + 1);
  return isValidAgyLaunchSpec({ model, effort }) ? effort : null;
}

export async function runInteractiveAgy({
  runner,
  route,
  config,
  initialModel = null,
  initialEffort = null,
  input = process.stdin,
  output = process.stdout,
  stderr = process.stderr,
  createLineInterface = createInterface,
  sessionFactory = createAgySession,
} = {}) {
  let streamed = false;
  let lastDelta = "";
  const session = sessionFactory({
    runner, route, config,
    onLaunch(spec) { stderr.write(`[Jev] ${spec.model} (effort ${spec.effort})\n`); },
    onAgentText(delta) {
      output.write(delta);
      streamed = true;
      lastDelta = delta;
    },
    onDiagnostic(chunk) { stderr.write(chunk); },
  });

  if (initialModel !== null) {
    const effort = manualEffort(initialModel);
    if (!effort || (initialEffort && initialEffort !== effort)) {
      stderr.write("[d3-agy] unsupported or conflicting manual Agy model/effort\n");
      return 1;
    }
    session.setManualModel(initialModel, effort);
  }

  const rl = createLineInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let closed = false;
  let pendingLine = null;
  let inputLocked = true;
  let turnActive = false;
  let cancelRequested = false;
  rl.on("line", (line) => {
    // A line is accepted only for the currently displayed prompt. Clear the
    // readline prompt before it can redraw during the active turn.
    if (inputLocked || !pendingLine) return;
    inputLocked = true;
    rl.setPrompt("");
    const resolve = pendingLine;
    pendingLine = null;
    resolve(line);
  });
  rl.on("close", () => {
    closed = true;
    if (pendingLine) {
      const resolve = pendingLine;
      pendingLine = null;
      resolve(null);
    }
  });
  rl.on("SIGINT", () => {
    if (!turnActive) {
      rl.close();
      return;
    }
    if (cancelRequested) return;
    cancelRequested = true;
    try {
      if (session.cancelCurrentTurn()) {
        stderr.write("Cancellation requested. Waiting for Agy to stop...\n");
      }
    } catch (error) {
      stderr.write(`[d3-agy] cancellation request failed: ${error.message}\n`);
    }
  });

  async function readLine(prompt) {
    if (closed) return null;
    // Drop an unfinished line typed while Agy was running before accepting
    // the next prompt (especially the recovery confirmation).
    if (rl.terminal && rl.line) {
      rl.line = "";
      rl.cursor = 0;
    }
    return new Promise((resolve) => {
      pendingLine = resolve;
      inputLocked = false;
      rl.setPrompt(prompt);
      rl.prompt();
    });
  }

  try {
    while (true) {
      const line = await readLine("agy> ");
      if (line === null) return 0;
      const command = line.trim();
      if (!command) continue;
      if (command === "/exit") return 0;
      if (command === "/help") { output.write(COMMAND_HELP); continue; }
      if (command === "/auto") { session.setAutomaticMode(); output.write("Automatic routing enabled.\n"); continue; }
      if (command === "/model" || command.startsWith("/model ")) {
        const model = command.slice("/model".length).trim();
        const effort = manualEffort(model);
        if (!effort) {
          stderr.write("[d3-agy] unsupported Agy model; use a valid Gemini model slug.\n");
          continue;
        }
        session.setManualModel(model, effort);
        output.write(`Manual model: ${model}\n`);
        continue;
      }
      if (command.startsWith("/")) {
        stderr.write("[d3-agy] unknown command; use /help.\n");
        continue;
      }

      streamed = false;
      lastDelta = "";
      turnActive = true;
      cancelRequested = false;
      let outcome;
      try {
        const effortOverride = session.getState().mode === "automatic" ? initialEffort : null;
        outcome = await session.runTurn(line, { effortOverride });
      } finally {
        turnActive = false;
      }
      if (streamed && !lastDelta.endsWith("\n")) output.write("\n");
      if (!streamed && outcome.ok && typeof outcome.semantic?.response === "string" && outcome.semantic.response) {
        output.write(outcome.semantic.response);
        if (!outcome.semantic.response.endsWith("\n")) output.write("\n");
      }
      if (!outcome.ok) stderr.write(`[d3-agy] turn did not complete cleanly (${outcome.status}).\n`);

      if (session.getState().recoveryRequired) {
        stderr.write("Agy may already have persisted conversation, tool, or file effects. Continuing does not roll back that work.\n");
        const answer = await readLine("Continue from the last verified conversation state? [y/N] ");
        if (answer === null || !/^y(es)?$/i.test(answer.trim())) return 0;
        session.acknowledgeRecovery();
      }
    }
  } finally {
    rl.close();
  }
}
