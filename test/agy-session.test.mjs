import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createAgyChildRunner, createAgySession } from "../src/agy-session.mjs";
import { routeAgyTier } from "../src/agy-routing.mjs";
import { DEFAULT_MODEL_CONFIG } from "../src/default-config.mjs";

function fakeRunner() {
  const runs = [];
  return {
    runs,
    run(spec, callbacks) {
      let resolve;
      const completed = new Promise((done) => { resolve = done; });
      const run = {
        spec,
        canceled: false,
        stdout(value) { callbacks.onStdout(value); },
        stderr(value) { callbacks.onStderr(value); },
        exit(code = 0, signal = null) { resolve({ code, signal }); },
        cancel() { run.canceled = true; resolve({ code: null, signal: "SIGTERM" }); },
      };
      runs.push(run);
      return { completed, cancel: run.cancel };
    },
  };
}

function controlledRunner(cancelBehavior = () => true) {
  const runs = [];
  return {
    runs,
    run(spec, callbacks) {
      let resolve;
      let reject;
      const completed = new Promise((done, fail) => { resolve = done; reject = fail; });
      const run = {
        spec,
        cancelCalls: 0,
        stdout(value) { callbacks.onStdout(value); },
        stderr(value) { callbacks.onStderr(value); },
        close(code = 0, signal = null) { resolve({ code, signal }); },
        reject(error) { reject(error); },
        cancel() {
          run.cancelCalls += 1;
          return cancelBehavior();
        },
      };
      runs.push(run);
      return { completed, cancel: run.cancel };
    },
  };
}

const result = (conversationId, numTurns, status = "SUCCESS") =>
  JSON.stringify({
    event: "result",
    result: { conversation_id: conversationId, status, response: "answer", num_turns: numTurns, usage: { total_tokens: 17 }, error: status === "SUCCESS" ? undefined : "failed" },
  }) + "\n";

async function launched(runner, expected) {
  for (let i = 0; i < 10 && runner.runs.length < expected; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.runs.length, expected);
  return runner.runs.at(-1);
}

function makeSession(runner, choice, callbacks = {}) {
  const calls = [];
  const session = createAgySession({
    runner, config: DEFAULT_MODEL_CONFIG,
    route: (input) => routeAgyTier({
      ...input,
      route: async (request) => {
        calls.push(request);
        return { choice: choice[calls.length - 1], confidence: 0.95 };
      },
    }),
    ...callbacks,
  });
  return { session, calls };
}

test("automatic turns route once each, change Gemini model, and reuse the exact ID", async () => {
  const runner = fakeRunner();
  const { session, calls } = makeSession(runner, ["gemini-3.8-flash-low", "gemini-3.8-flash-high"]);
  const first = session.runTurn("simple first turn");
  const one = await launched(runner, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].models.every(({ id }) => id.startsWith("gemini-")));
  assert.equal(one.spec.model, "gemini-3.8-flash-low");
  assert.equal(one.spec.conversationId, null);
  assert.equal(one.spec.args.includes("--conversation"), false);
  assert.equal(Object.isFrozen(one.spec), true);
  assert.equal(Object.isFrozen(one.spec.args), true);
  one.stdout(result("conversation-1", 1));
  one.exit();
  assert.equal((await first).ok, true);
  assert.equal(session.getState().conversationId, "conversation-1");

  const second = session.runTurn("hard second turn");
  const two = await launched(runner, 2);
  assert.equal(calls.length, 2);
  assert.equal(two.spec.model, "gemini-3.8-flash-high");
  assert.equal(two.spec.conversationId, "conversation-1");
  assert.deepEqual(two.spec.args.slice(6, 8), ["--conversation", "conversation-1"]);
  assert.equal(two.spec.args[two.spec.args.indexOf("--model") + 1], two.spec.model);
  two.stdout(result("conversation-1", 2));
  two.exit();
  assert.equal((await second).ok, true);
  assert.equal(session.getState().numTurns, 2);
  assert.equal(session.getState().model, "gemini-3.8-flash-high");
});

test("launch observer receives the final spawned spec before child output", async () => {
  const runner = fakeRunner();
  const seen = [];
  const { session } = makeSession(runner, ["gemini-3.8-flash-high"], {
    onLaunch(spec) { seen.push(spec); },
  });
  const pending = session.runTurn("show launch");
  const run = await launched(runner, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], run.spec);
  assert.equal(seen[0].args[1], seen[0].model);
  run.stdout(result("launch-id", 1));
  run.exit();
  assert.equal((await pending).ok, true);
});

test("launch observer cannot alter the child spec and a throw fails before spawn", async () => {
  const runner = fakeRunner();
  const { session } = makeSession(runner, ["gemini-3.8-flash-high"], {
    onLaunch(spec) { spec.model = "claude-opus-5"; spec.args[1] = "claude-opus-5"; },
  });
  const pending = session.runTurn("copy");
  const run = await launched(runner, 1);
  assert.equal(run.spec.model, "gemini-3.8-flash-high");
  assert.equal(run.spec.args[1], "gemini-3.8-flash-high");
  run.stdout(result("copy-id", 1));
  run.exit();
  assert.equal((await pending).ok, true);

  const failingRunner = fakeRunner();
  const failed = makeSession(failingRunner, ["gemini-3.8-flash-high"], {
    onLaunch() { throw new Error("render failed"); },
  }).session;
  const outcome = await failed.runTurn("fail before spawn");
  assert.equal(outcome.status, "LAUNCH_ERROR");
  assert.equal(failingRunner.runs.length, 0);
  assert.equal(failed.getState().conversationId, null);
  assert.equal(failed.getState().recoveryRequired, true);
});

test("manual valid model bypasses Jev and can return to automatic mode", async () => {
  const runner = fakeRunner();
  const { session, calls } = makeSession(runner, ["gemini-3.8-flash-low"]);
  session.setManualModel("gemini-3.1-pro-high", "high");
  assert.equal(session.getState().mode, "manual");
  const pending = session.runTurn("manual");
  const run = await launched(runner, 1);
  assert.equal(calls.length, 0);
  assert.equal(run.spec.model, "gemini-3.1-pro-high");
  run.stdout(result("manual-id", 1));
  run.exit();
  assert.equal((await pending).ok, true);
  session.setAutomaticMode();
  assert.equal(session.getState().mode, "automatic");
  assert.throws(() => session.setManualModel("claude-opus-5-high", "high"), /unsupported manual/);
  assert.throws(() => session.setManualModel("gpt-6-sol-high", "high"), /unsupported manual/);
});

test("agent deltas, tool steps, diagnostics, and final outcome stay structured and ordered", async () => {
  const runner = fakeRunner();
  const text = [];
  const steps = [];
  const diagnostics = [];
  const outcomes = [];
  const { session } = makeSession(runner, ["gemini-3.8-flash-high"], {
    onAgentText: (value) => text.push(value),
    onStep: (value) => steps.push(value),
    onDiagnostic: (value) => diagnostics.push(value),
    onResult: (value) => outcomes.push(value),
  });
  const pending = session.runTurn("stream");
  const run = await launched(runner, 1);
  for (const value of ["a", "b"]) {
    run.stdout(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: value } }) + "\n");
  }
  run.stdout(JSON.stringify({ event: "step_update", step_update: { step_type: "tool", tool_info: { name: "read_file" } } }) + "\n");
  run.stderr("diagnostic");
  run.stdout(result("stream-id", 1));
  run.exit();
  assert.equal((await pending).ok, true);
  assert.deepEqual(text, ["a", "b"]);
  assert.equal(steps[2].tool_info.name, "read_file");
  assert.deepEqual(diagnostics, ["diagnostic"]);
  assert.equal(outcomes.length, 1);
});

test("a mismatched resumed ID is a protocol error and retains the verified ID", async () => {
  const runner = fakeRunner();
  const { session } = makeSession(runner, ["gemini-3.8-flash-high", "gemini-3.8-flash-low"]);
  const first = session.runTurn("one");
  (await launched(runner, 1)).stdout(result("verified", 1));
  runner.runs[0].exit();
  await first;
  const second = session.runTurn("two");
  const run = await launched(runner, 2);
  run.stdout(result("different", 2));
  run.exit();
  const outcome = await second;
  assert.equal(outcome.status, "PROTOCOL_ERROR");
  assert.equal(session.getState().conversationId, "verified");
  assert.equal(session.getState().recoveryRequired, true);
  await assert.rejects(session.runTurn("blocked"), /acknowledge recovery/);
});

test("ERROR result preserves the last verified conversation ID", async () => {
  const runner = fakeRunner();
  const { session } = makeSession(runner, ["gemini-3.8-flash-high", "gemini-3.8-flash-high"]);
  const first = session.runTurn("one");
  (await launched(runner, 1)).stdout(result("verified", 1));
  runner.runs[0].exit();
  await first;
  const second = session.runTurn("two");
  const run = await launched(runner, 2);
  run.stdout(result("", 0, "ERROR"));
  run.exit(1);
  const outcome = await second;
  assert.equal(outcome.status, "ERROR");
  assert.equal(outcome.semantic.error, "failed");
  assert.equal(session.getState().conversationId, "verified");
  session.acknowledgeRecovery();
  assert.equal(session.getState().recoveryRequired, false);
});

test("other terminal statuses remain failures regardless of exit code", async () => {
  for (const status of ["CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING", "FUTURE_STATUS"]) {
    const runner = fakeRunner();
    const { session } = makeSession(runner, ["gemini-3.8-flash-high"]);
    const pending = session.runTurn(status);
    const run = await launched(runner, 1);
    run.stdout(result("", 0, status));
    run.exit(0);
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, status);
    assert.equal(session.getState().conversationId, null);
  }
});

test("missing, duplicate, malformed, and partial result streams fail closed", async () => {
  for (const output of ["", result("id", 1) + result("id", 1), '{"event":bad}\n', '{"event":"result"']) {
    const runner = fakeRunner();
    const { session } = makeSession(runner, ["gemini-3.8-flash-high"]);
    const pending = session.runTurn("test");
    const run = await launched(runner, 1);
    if (output) run.stdout(output);
    run.exit();
    const outcome = await pending;
    assert.equal(outcome.status, "PROTOCOL_ERROR");
    assert.equal(session.getState().conversationId, null);
    assert.equal(session.getState().recoveryRequired, true);
  }
});

test("SUCCESS with nonzero exit cannot commit conversation state", async () => {
  const runner = fakeRunner();
  const { session } = makeSession(runner, ["gemini-3.8-flash-high"]);
  const pending = session.runTurn("test");
  const run = await launched(runner, 1);
  run.stdout(result("unverified", 1));
  run.exit(2);
  assert.equal((await pending).status, "EXIT_ERROR");
  assert.equal(session.getState().conversationId, null);
});

test("init metadata must agree with the resolved launch and terminal result", async () => {
  for (const init of [
    { model: "gemini-3.8-flash-low", conversation_id: "id" },
    { model: "gemini-3.8-flash-high", conversation_id: "other-id" },
  ]) {
    const runner = fakeRunner();
    const { session } = makeSession(runner, ["gemini-3.8-flash-high"]);
    const pending = session.runTurn("test");
    const run = await launched(runner, 1);
    run.stdout(JSON.stringify({ event: "init", conversation_id: init.conversation_id, init: { model: init.model } }) + "\n");
    if (!run.canceled) run.stdout(result("id", 1));
    run.exit();
    assert.equal((await pending).status, "PROTOCOL_ERROR");
    assert.equal(session.getState().conversationId, null);
  }
});

test("concurrent turn is rejected while routing or child execution is active", async () => {
  const runner = fakeRunner();
  let release;
  const session = createAgySession({
    runner, config: DEFAULT_MODEL_CONFIG,
    route: () => new Promise((resolve) => { release = resolve; }),
  });
  const pending = session.runTurn("first");
  await assert.rejects(session.runTurn("second"), /already active/);
  release({ tier: "strong", model: "gemini-3.8-flash-high", effort: "high" });
  const run = await launched(runner, 1);
  await assert.rejects(session.runTurn("second"), /already active/);
  run.stdout(result("id", 1));
  run.exit();
  await pending;
});

test("cancellation is a no-op when idle and blocks reuse until acknowledged", async () => {
  const runner = fakeRunner();
  const { session } = makeSession(runner, ["gemini-3.8-flash-high", "gemini-3.8-flash-low"]);
  assert.equal(session.cancelCurrentTurn(), false);
  const first = session.runTurn("verified turn");
  (await launched(runner, 1)).stdout(result("verified", 1));
  runner.runs[0].exit();
  await first;
  const pending = session.runTurn("cancel me");
  const run = await launched(runner, 2);
  assert.equal(run.spec.conversationId, "verified");
  assert.equal(session.cancelCurrentTurn(), true);
  assert.equal(run.canceled, true);
  const outcome = await pending;
  assert.equal(outcome.status, "CANCELED");
  assert.equal(session.getState().conversationId, "verified");
  assert.equal(session.getState().recoveryRequired, true);
});

test("Jev failure retains a valid Gemini fallback", async () => {
  const runner = fakeRunner();
  const session = createAgySession({
    runner, config: DEFAULT_MODEL_CONFIG,
    route: (input) => routeAgyTier({ ...input, route: async () => null }),
  });
  const pending = session.runTurn("fallback");
  const run = await launched(runner, 1);
  assert.equal(run.spec.model, "gemini-3.8-flash-high");
  run.stdout(result("fallback-id", 1));
  run.exit();
  assert.equal((await pending).ok, true);
});

test("child failure before spawn completion returns a structured failure", async () => {
  const session = createAgySession({
    runner: { run() { throw new Error("spawn failed"); } },
    config: DEFAULT_MODEL_CONFIG,
    route: async () => ({ tier: "strong", model: "gemini-3.8-flash-high", effort: "high" }),
  });
  const outcome = await session.runTurn("prompt");
  assert.equal(outcome.status, "LAUNCH_ERROR");
  assert.match(outcome.error, /spawn failed/);
  assert.equal(session.getState().conversationId, null);
});

test("each streaming callback failure is contained and leaves verified state unchanged", async () => {
  const step = JSON.stringify({ event: "step_update", step_update: {
    step_type: "agent_response", state: "ACTIVE", text_delta: "delta",
  } }) + "\n";
  for (const callbackName of ["onEvent", "onStep", "onAgentText", "onDiagnostic"]) {
    const runner = controlledRunner();
    let resultCalls = 0;
    const { session } = makeSession(runner, ["gemini-3.8-flash-high"], {
      [callbackName]: () => { throw new Error(`${callbackName} failed`); },
      onResult: () => { resultCalls += 1; },
    });
    const pending = session.runTurn("callback");
    const run = await launched(runner, 1);
    assert.doesNotThrow(() => callbackName === "onDiagnostic" ? run.stderr("diagnostic") : run.stdout(step));
    assert.equal(run.cancelCalls, 1);
    assert.equal(session.getState().active, true);
    run.close();
    const outcome = await pending;
    assert.equal(outcome.status, "CALLBACK_ERROR");
    assert.equal(outcome.callbackError.callback, callbackName);
    assert.equal(session.getState().conversationId, null);
    assert.equal(session.getState().recoveryRequired, true);
    assert.equal(resultCalls, 1);
  }
});

test("onResult failure is reported once without reverting committed SUCCESS", async () => {
  const runner = controlledRunner();
  let resultCalls = 0;
  const { session } = makeSession(runner, ["gemini-3.8-flash-high"], {
    onResult: () => { resultCalls += 1; throw new Error("render result failed"); },
  });
  const pending = session.runTurn("success");
  const run = await launched(runner, 1);
  run.stdout(result("verified", 1));
  run.close();
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "SUCCESS");
  assert.equal(outcome.resultCallbackError.message, "render result failed");
  assert.equal(resultCalls, 1);
  assert.equal(session.getState().conversationId, "verified");
  assert.equal(session.getState().recoveryRequired, false);
  assert.equal(session.cancelCurrentTurn(), false);
});

test("observer mutation cannot forge a successful result or alter returned outcome", async () => {
  const runner = controlledRunner();
  const { session } = makeSession(runner, ["gemini-3.8-flash-high"], {
    onEvent: (event) => {
      if (event.event === "result") {
        event.result.status = "SUCCESS";
        event.result.conversation_id = "forged";
      }
    },
    onResult: (outcome) => { outcome.status = "SUCCESS"; },
  });
  const pending = session.runTurn("failure");
  const run = await launched(runner, 1);
  run.stdout(result("", 0, "ERROR"));
  run.close();
  const outcome = await pending;
  assert.equal(outcome.status, "ERROR");
  assert.equal(session.getState().conversationId, null);
  assert.equal(session.getState().recoveryRequired, true);
});

test("resumed SUCCESS requires cumulative turn count to advance", async () => {
  const runner = controlledRunner();
  const { session } = makeSession(runner, ["gemini-3.8-flash-high", "gemini-3.8-flash-high"]);
  const first = session.runTurn("first");
  (await launched(runner, 1)).stdout(result("verified", 1));
  runner.runs[0].close();
  await first;
  const second = session.runTurn("second");
  const run = await launched(runner, 2);
  run.stdout(result("verified", 1));
  run.close();
  assert.equal((await second).status, "PROTOCOL_ERROR");
  assert.equal(session.getState().numTurns, 1);
  assert.equal(session.getState().conversationId, "verified");
});

test("cancel is idempotent and keeps the lock until a false, no-op, or throwing hook's child closes", async () => {
  for (const behavior of [() => false, () => undefined, () => { throw new Error("kill failed"); }]) {
    const runner = controlledRunner(behavior);
    const { session } = makeSession(runner, ["gemini-3.8-flash-high"]);
    const pending = session.runTurn("cancel");
    const run = await launched(runner, 1);
    assert.equal(session.cancelCurrentTurn(), true);
    assert.equal(session.cancelCurrentTurn(), false);
    assert.equal(run.cancelCalls, 1);
    assert.equal(session.getState().active, true);
    assert.throws(() => session.acknowledgeRecovery(), /already active/);
    await assert.rejects(session.runTurn("too early"), /already active/);
    run.stdout(result("unverified", 1));
    run.close();
    const outcome = await pending;
    assert.equal(outcome.status, "CANCELED");
    assert.match(outcome.cancelError, /not confirmed|kill failed/);
    assert.equal(session.getState().conversationId, null);
  }
});

test("cancel during routing prevents launch; cancel during runner setup uses the later handle", async () => {
  const runner = controlledRunner();
  let release;
  const routingSession = createAgySession({
    runner, config: DEFAULT_MODEL_CONFIG,
    route: () => new Promise((resolve) => { release = resolve; }),
  });
  const routingTurn = routingSession.runTurn("routing");
  assert.equal(routingSession.cancelCurrentTurn(), true);
  release({ tier: "strong", model: "gemini-3.8-flash-high", effort: "high" });
  assert.equal((await routingTurn).status, "CANCELED");
  assert.equal(runner.runs.length, 0);

  let session;
  const setupRunner = {
    runs: [],
    run(spec, callbacks) {
      const child = controlledRunner();
      callbacks.onStdout(JSON.stringify({ event: "init", conversation_id: "id", init: { model: spec.model } }) + "\n");
      const handle = child.run(spec, callbacks);
      this.runs.push(child.runs[0]);
      return handle;
    },
  };
  session = createAgySession({
    runner: setupRunner, config: DEFAULT_MODEL_CONFIG,
    route: async () => ({ tier: "strong", model: "gemini-3.8-flash-high", effort: "high" }),
    onEvent: () => { session.cancelCurrentTurn(); },
  });
  const pending = session.runTurn("setup");
  const run = await launched(setupRunner, 1);
  assert.equal(run.cancelCalls, 1);
  assert.equal(session.getState().active, true);
  run.close();
  assert.equal((await pending).status, "CANCELED");
});

test("cancel after SUCCESS before close ignores further output and preserves previous state", async () => {
  const runner = controlledRunner();
  const text = [];
  const { session } = makeSession(runner, ["gemini-3.8-flash-high", "gemini-3.8-flash-low"], {
    onAgentText: (value) => text.push(value),
  });
  const first = session.runTurn("first");
  (await launched(runner, 1)).stdout(result("verified", 1));
  runner.runs[0].close();
  await first;

  const second = session.runTurn("second");
  const run = await launched(runner, 2);
  run.stdout(result("verified", 2));
  assert.equal(session.cancelCurrentTurn(), true);
  run.stdout(JSON.stringify({ event: "step_update", step_update: {
    step_type: "agent_response", text_delta: "late",
  } }) + "\n");
  assert.deepEqual(text, []);
  assert.equal(session.getState().active, true);
  run.close();
  assert.equal((await second).status, "CANCELED");
  assert.equal(session.getState().conversationId, "verified");
  assert.equal(session.getState().numTurns, 1);
});

test("cancel racing with a terminal child completion remains conservative", async () => {
  const runner = controlledRunner();
  const { session } = makeSession(runner, ["gemini-3.8-flash-high"]);
  const pending = session.runTurn("race");
  const run = await launched(runner, 1);
  run.stdout(result("id", 1));
  run.close();
  assert.equal(session.cancelCurrentTurn(), true);
  assert.equal((await pending).status, "CANCELED");
  assert.equal(session.getState().conversationId, null);
});

test("injected completion rejection is a controlled process failure", async () => {
  const runner = controlledRunner();
  const { session } = makeSession(runner, ["gemini-3.8-flash-high"]);
  const pending = session.runTurn("reject");
  const run = await launched(runner, 1);
  run.reject(new Error("terminal runner failure"));
  const outcome = await pending;
  assert.equal(outcome.status, "PROCESS_ERROR");
  assert.match(outcome.error, /terminal runner failure/);
  assert.equal(session.getState().conversationId, null);
});

test("production error waits for close, settles once, and cleans listeners", async () => {
  let child;
  const runner = createAgyChildRunner({
    executable: "agy.exe", env: {},
    spawnProcess() {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      return child;
    },
  });
  const session = createAgySession({
    runner, config: DEFAULT_MODEL_CONFIG,
    route: async () => ({ tier: "strong", model: "gemini-3.8-flash-high", effort: "high" }),
  });
  const pending = session.runTurn("error before close");
  for (let i = 0; i < 10 && !child; i += 1) await new Promise((resolve) => setImmediate(resolve));
  child.emit("error", new Error("process error"));
  assert.equal(session.getState().active, true);
  assert.throws(() => session.acknowledgeRecovery(), /already active/);
  await assert.rejects(session.runTurn("too early"), /already active/);
  child.emit("close", 1, null);
  const outcome = await pending;
  assert.equal(outcome.status, "PROCESS_ERROR");
  assert.match(outcome.error, /process error/);
  assert.equal(session.getState().recoveryRequired, true);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  child.emit("close", 0, null);
  assert.equal(session.getState().conversationId, null);
});

test("production runner passes literal arguments to a shell-free child", async () => {
  let captured;
  const fakeSpawn = (file, args, options) => {
    captured = { file, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  const runner = createAgyChildRunner({ executable: "agy.exe", spawnProcess: fakeSpawn, env: {} });
  const spec = { args: ["-p", "literal & | > < ^"] };
  const child = runner.run(spec, { onStdout() {}, onStderr() {} });
  assert.deepEqual(await child.completed, { code: 0, signal: null, error: null });
  assert.equal(captured.file, "agy.exe");
  assert.equal(captured.options.shell, false);
  assert.deepEqual(captured.args, spec.args);
  assert.throws(() => createAgyChildRunner({ executable: "agy.cmd" }), /directly executable/);
});
