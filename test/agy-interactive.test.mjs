import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import test from "node:test";
import { runInteractiveAgy } from "../src/agy-interactive.mjs";
import { runAgy } from "../src/agy-cli.mjs";
import { DEFAULT_MODEL_CONFIG } from "../src/default-config.mjs";

class FakeLines extends EventEmitter {
  prompts = [];
  closed = false;
  setPrompt(value) { this.currentPrompt = value; }
  prompt() { this.prompts.push(this.currentPrompt); }
  push(value) { this.emit("line", value); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const launch = (model = "gemini-3.8-flash-high", conversationId = null) => ({
  model, effort: model.slice(model.lastIndexOf("-") + 1), conversationId,
  args: ["--model", model, "--effort", model.slice(model.lastIndexOf("-") + 1)],
});

function harness({ turn, recovery = false } = {}) {
  const lines = new FakeLines();
  let stdout = "";
  let stderr = "";
  let callbacks;
  let mode = "automatic";
  let recoveryRequired = recovery;
  let conversationId = null;
  const calls = [];
  let cancels = 0;
  let autos = 0;
  let acknowledgments = 0;
  const session = {
    getState: () => ({ mode, recoveryRequired, conversationId }),
    setAutomaticMode() { autos += 1; mode = "automatic"; },
    setManualModel(model, effort) { calls.push({ manual: model, effort }); mode = "manual"; },
    acknowledgeRecovery() { acknowledgments += 1; recoveryRequired = false; },
    cancelCurrentTurn() { cancels += 1; return true; },
    async runTurn(prompt, options) {
      calls.push({ prompt, options });
      const spec = launch(mode === "manual" ? calls.findLast((call) => call.manual)?.manual : undefined, conversationId);
      callbacks.onLaunch(spec);
      const outcome = turn ? await turn({ prompt, options, callbacks, spec, setRecovery(value) { recoveryRequired = value; }, setConversation(value) { conversationId = value; } })
        : { ok: true, status: "SUCCESS", spec };
      return outcome;
    },
  };
  const done = runInteractiveAgy({
    runner: {}, route() {}, config: DEFAULT_MODEL_CONFIG,
    createLineInterface: () => lines,
    sessionFactory: (options) => { callbacks = options; return session; },
    output: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  });
  return { lines, done, session, calls, get output() { return stdout; }, get errors() { return stderr; }, get cancels() { return cancels; }, get autos() { return autos; }, get acknowledgments() { return acknowledgments; } };
}

test("bare CLI enters interactive mode while -p retains the one-shot spawn path", async () => {
  let interactiveCalls = 0;
  let spawned = 0;
  await runAgy([], {
    executable: "agy.exe", config: DEFAULT_MODEL_CONFIG, env: {}, loadEnv() {},
    interactive() { interactiveCalls += 1; return 0; },
    spawnProcess() { spawned += 1; return new EventEmitter(); },
  });
  assert.equal(interactiveCalls, 1);
  assert.equal(spawned, 0);
  await runAgy(["-p", "hello"], {
    executable: "agy.exe", config: DEFAULT_MODEL_CONFIG, env: {}, loadEnv() {},
    interactive() { interactiveCalls += 1; return 0; },
    spawnProcess() { spawned += 1; return new EventEmitter(); },
  });
  assert.equal(interactiveCalls, 1);
  assert.equal(spawned, 1);
  process.exitCode = undefined;
});

test("interactive turns are sequential, stream once in order, and display the launch spec", async () => {
  const h = harness({ turn: async ({ callbacks, spec, setConversation }) => {
    callbacks.onAgentText("first ");
    callbacks.onAgentText("second");
    setConversation("same-id");
    return { ok: true, status: "SUCCESS", spec };
  } });
  h.lines.push("one");
  await tick();
  h.lines.push("two");
  await tick();
  h.lines.push("/exit");
  assert.equal(await h.done, 0);
  assert.deepEqual(h.calls.filter((call) => call.prompt).map((call) => call.prompt), ["one", "two"]);
  assert.equal(h.output, "first second\nfirst second\n");
  assert.equal((h.errors.match(/\[Jev\] gemini-3\.8-flash-high \(effort high\)/g) ?? []).length, 2);
  assert.equal(h.lines.prompts.filter((value) => value === "agy> ").length, 3);
});

test("terminal response renders once when no text deltas were emitted", async () => {
  const h = harness({ turn: async ({ spec }) => ({
    ok: true, status: "SUCCESS", spec, semantic: { response: "complete answer" },
  }) });
  h.lines.push("work");
  await tick();
  h.lines.push("/exit");
  await h.done;
  assert.equal(h.output, "complete answer\n");
});

test("minimal commands change modes; invalid models and unknown commands never run a turn", async () => {
  const h = harness();
  for (const line of ["/help", "/model claude-opus-5-high", "/model gemini-3.1-pro-high", "manual turn", "/auto", "automatic turn", "/unknown", "/exit"]) {
    h.lines.push(line);
    await tick();
  }
  await h.done;
  assert.match(h.output, /Commands: \/help, \/auto, \/model .* \/exit/);
  assert.match(h.output, /Manual model: gemini-3\.1-pro-high/);
  assert.match(h.output, /Automatic routing enabled/);
  assert.match(h.errors, /unsupported Agy model/);
  assert.match(h.errors, /unknown command/);
  assert.deepEqual(h.calls.filter((call) => call.prompt).map((call) => call.prompt), ["manual turn", "automatic turn"]);
  assert.equal(h.calls.find((call) => call.manual)?.effort, "high");
});

test("EOF and idle Ctrl+C exit cleanly", async () => {
  const eof = harness();
  eof.lines.close();
  assert.equal(await eof.done, 0);
  const sigint = harness();
  sigint.lines.emit("SIGINT");
  assert.equal(await sigint.done, 0);
});

test("a held turn suppresses agy prompt and discards commands and type-ahead", async () => {
  let settle;
  const h = harness({ turn: ({ spec }) => new Promise((resolve) => {
    settle = () => resolve({ ok: true, status: "SUCCESS", spec });
  }) });
  assert.deepEqual(h.lines.prompts, ["agy> "]);
  h.lines.push("Reply with exactly: MANUAL_OK");
  await tick();
  assert.equal(h.lines.currentPrompt, "");
  assert.deepEqual(h.lines.prompts, ["agy> "]);

  for (const line of ["/help", "/exit", "/auto", "/model gemini-3.1-pro-high", "another prompt"]) {
    h.lines.push(line);
  }
  await tick();
  assert.deepEqual(h.lines.prompts, ["agy> "]);
  assert.equal(h.output.includes("Commands:"), false);
  assert.equal(h.autos, 0);
  assert.equal(h.calls.filter((call) => call.manual).length, 0);
  assert.deepEqual(h.calls.filter((call) => call.prompt).map((call) => call.prompt), ["Reply with exactly: MANUAL_OK"]);

  settle();
  await tick();
  assert.deepEqual(h.lines.prompts, ["agy> ", "agy> "]);
  assert.equal(h.lines.currentPrompt, "agy> ");
  h.lines.push("/exit");
  assert.equal(await h.done, 0);
});

test("terminal readline does not redraw agy prompt during a held turn", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  let rendered = "";
  output.on("data", (chunk) => { rendered += String(chunk); });
  let settle;
  let turns = 0;
  const done = runInteractiveAgy({
    runner: {}, config: DEFAULT_MODEL_CONFIG, input, output,
    stderr: { write() {} },
    sessionFactory: () => ({
      getState: () => ({ mode: "automatic", recoveryRequired: false }),
      runTurn() {
        turns += 1;
        return new Promise((resolve) => { settle = () => resolve({ ok: true, status: "SUCCESS" }); });
      },
    }),
  });
  input.write("Reply with exactly: MANUAL_OK\r");
  await tick();
  assert.equal(turns, 1);
  const afterSubmission = rendered;
  input.write("/help\r/exit\r");
  await tick();
  assert.equal(rendered.slice(afterSubmission.length).includes("agy> "), false);
  assert.equal(rendered.includes("Commands:"), false);
  assert.equal(turns, 1);
  settle();
  await tick();
  assert.equal((rendered.slice(afterSubmission.length).match(/agy> /g) ?? []).length, 1);
  input.write("/exit\r");
  assert.equal(await done, 0);
  input.destroy();
  output.destroy();
});

test("unfinished terminal input from an active turn cannot confirm recovery", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  let recoveryRequired = false;
  let acknowledgments = 0;
  let settle;
  let rl;
  const done = runInteractiveAgy({
    runner: {}, config: DEFAULT_MODEL_CONFIG, input, output,
    stderr: { write() {} },
    createLineInterface(options) { rl = createInterface(options); return rl; },
    sessionFactory: () => ({
      getState: () => ({ mode: "automatic", recoveryRequired }),
      acknowledgeRecovery() { acknowledgments += 1; recoveryRequired = false; },
      runTurn() {
        return new Promise((resolve) => {
          settle = () => {
            recoveryRequired = true;
            resolve({ ok: false, status: "ERROR" });
          };
        });
      },
    }),
  });
  input.write("work\r");
  await tick();
  input.write("yes"); // no Enter: this line belongs to the active turn
  assert.equal(rl.line, "yes");
  assert.equal(rl.terminal, true);
  settle();
  await tick();
  assert.equal(rl.line, "");
  input.write("\r");
  await tick();
  input.end();
  assert.equal(await done, 0);
  assert.equal(acknowledgments, 0);
  input.destroy();
  output.destroy();
});

test("type-ahead yes cannot acknowledge a later recovery question", async () => {
  let settle;
  const h = harness({ turn: ({ spec, setRecovery }) => new Promise((resolve) => {
    settle = () => { setRecovery(true); resolve({ ok: false, status: "ERROR", spec }); };
  }) });
  h.lines.push("work");
  await tick();
  h.lines.push("yes");
  settle();
  await tick();
  assert.equal(h.acknowledgments, 0);
  assert.deepEqual(h.lines.prompts, ["agy> ", "Continue from the last verified conversation state? [y/N] "]);
  h.lines.push("no");
  assert.equal(await h.done, 0);
  assert.equal(h.acknowledgments, 0);
});

test("active Ctrl+C cancels once and keeps the prompt locked until settlement", async () => {
  let settle;
  const h = harness({ turn: ({ spec, setRecovery }) => new Promise((resolve) => {
    settle = () => { setRecovery(true); resolve({ ok: false, status: "CANCELED", spec }); };
  }) });
  h.lines.push("work");
  await tick();
  assert.equal(h.calls.filter((call) => call.prompt).length, 1);
  h.lines.emit("SIGINT");
  h.lines.emit("SIGINT");
  h.lines.push("/help");
  h.lines.push("yes");
  h.lines.push("another turn");
  await tick();
  assert.equal(h.cancels, 1);
  assert.equal(h.lines.prompts.length, 1);
  assert.equal(h.calls.filter((call) => call.prompt).length, 1);
  assert.equal(h.output.includes("Commands:"), false);
  settle();
  await tick();
  assert.equal(h.lines.prompts.at(-1), "Continue from the last verified conversation state? [y/N] ");
  h.lines.push("no");
  await h.done;
  assert.equal(h.calls.filter((call) => call.prompt).length, 1);
  assert.equal(h.acknowledgments, 0);
  assert.match(h.errors, /Cancellation requested\. Waiting for Agy to stop/);
  assert.match(h.errors, /may already have persisted/);
});

test("recovery requires yes to acknowledge and never replays the failed prompt", async () => {
  let turns = 0;
  const h = harness({ turn: async ({ spec, setRecovery }) => {
    turns += 1;
    if (turns === 1) { setRecovery(true); return { ok: false, status: "ERROR", spec }; }
    return { ok: true, status: "SUCCESS", spec };
  } });
  for (const line of ["first", "yes", "second", "/exit"]) { h.lines.push(line); await tick(); }
  await h.done;
  assert.equal(h.acknowledgments, 1);
  assert.deepEqual(h.calls.filter((call) => call.prompt).map((call) => call.prompt), ["first", "second"]);
  assert.equal(h.lines.prompts.filter((value) => value.includes("last verified")).length, 1);
});

test("recovery no exits without acknowledging or launching another turn", async () => {
  const h = harness({ turn: async ({ spec, setRecovery }) => {
    setRecovery(true);
    return { ok: false, status: "ERROR", spec };
  } });
  h.lines.push("first");
  await tick();
  h.lines.push("no");
  await h.done;
  assert.equal(h.acknowledgments, 0);
  assert.equal(h.calls.filter((call) => call.prompt).length, 1);
});

test("initial manual model is validated before opening readline", async () => {
  let opened = false;
  const code = await runInteractiveAgy({
    runner: {}, config: DEFAULT_MODEL_CONFIG, initialModel: "gpt-6-sol",
    sessionFactory: () => ({ setManualModel() { throw new Error("should not be called"); } }),
    createLineInterface() { opened = true; },
    stderr: { write() {} },
  });
  assert.equal(code, 1);
  assert.equal(opened, false);
});

test("explicit interactive --model enters validated manual mode", async () => {
  let selected;
  await runAgy(["--model", "gemini-3.1-pro-high"], {
    executable: "agy.exe", config: DEFAULT_MODEL_CONFIG, env: {}, loadEnv() {},
    interactive(options) { selected = options; return 0; },
  });
  assert.equal(selected.initialModel, "gemini-3.1-pro-high");
  assert.equal(selected.initialEffort, null);
  process.exitCode = undefined;

  const lines = new FakeLines();
  let manual;
  const done = runInteractiveAgy({
    runner: {}, config: DEFAULT_MODEL_CONFIG, initialModel: "gemini-3.1-pro-high",
    sessionFactory: () => ({ setManualModel(model, effort) { manual = { model, effort }; } }),
    createLineInterface: () => lines,
    output: { write() {} }, stderr: { write() {} },
  });
  lines.push("/exit");
  assert.equal(await done, 0);
  assert.deepEqual(manual, { model: "gemini-3.1-pro-high", effort: "high" });
});

test("EOF during an active turn waits for terminal settlement", async () => {
  let settle;
  const h = harness({ turn: ({ spec }) => new Promise((resolve) => {
    settle = () => resolve({ ok: true, status: "SUCCESS", spec });
  }) });
  h.lines.push("work");
  await tick();
  h.lines.close();
  let done = false;
  h.done.then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  settle();
  assert.equal(await h.done, 0);
});
