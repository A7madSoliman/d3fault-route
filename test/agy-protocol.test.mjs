import assert from "node:assert/strict";
import test from "node:test";
import { createAgyEventParser, validateAgyResult } from "../src/agy-protocol.mjs";

const id = "disposable-conversation";
const init = {
  event: "init", conversation_id: id,
  init: { model: "gemini-3.8-flash-high", cwd: "/tmp/project", tools: ["run_command"] },
};
const delta = {
  event: "step_update",
  step_update: { conversation_id: id, step_type: "agent_response", state: "ACTIVE", text_delta: "hello" },
};
const success = {
  event: "result",
  result: { conversation_id: id, status: "SUCCESS", response: "", num_turns: 3, usage: { future_count: 7 } },
};

test("parses complete init and response delta events for later rendering", () => {
  const parser = createAgyEventParser();
  assert.deepEqual(parser.push(`${JSON.stringify(init)}\n`), [init]);
  assert.deepEqual(parser.push(`${JSON.stringify(delta)}\n`), [delta]);
  assert.deepEqual(parser.finish(), []);
});

test("validates SUCCESS with empty response and preserves usage and extra fields", () => {
  const event = { ...success, result: { ...success.result, future: { enabled: true } } };
  const parser = createAgyEventParser();
  const [parsed] = parser.push(`${JSON.stringify(event)}\n`);
  const outcome = validateAgyResult(parsed, { expectedConversationId: id });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.conversationId, id);
  assert.equal(outcome.numTurns, 3);
  assert.equal(outcome.response, "");
  assert.deepEqual(outcome.usage, { future_count: 7 });
  assert.deepEqual(outcome.result.future, { enabled: true });
});

test("non-success and unknown statuses never become successful results", () => {
  for (const status of ["ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING", "FUTURE_STATUS"]) {
    const event = { event: "result", result: { conversation_id: "", status, error: "detail", num_turns: 0 } };
    const outcome = validateAgyResult(event, { expectedConversationId: id });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, status);
    assert.equal(outcome.error, "detail");
  }
});

test("handles a JSON line split across text and UTF-8 buffer chunks", () => {
  const parser = createAgyEventParser();
  const line = Buffer.from(`${JSON.stringify({ ...delta, step_update: { ...delta.step_update, text_delta: "café" } })}\n`);
  const accented = line.indexOf(Buffer.from("é"));
  assert.deepEqual(parser.push(line.subarray(0, 18)), []);
  assert.deepEqual(parser.push(line.subarray(18, accented + 1)), []);
  const events = parser.push(line.subarray(accented + 1));
  assert.equal(events[0].step_update.text_delta, "café");
  parser.finish();
});

test("handles multiple LF events in one chunk", () => {
  const parser = createAgyEventParser();
  assert.deepEqual(parser.push(`${JSON.stringify(init)}\n${JSON.stringify(delta)}\n${JSON.stringify(success)}\n`), [init, delta, success]);
  parser.finish();
});

test("handles CRLF and ignores blank lines", () => {
  const parser = createAgyEventParser();
  assert.deepEqual(parser.push(`\r\n  \r\n${JSON.stringify(init)}\r\n\n`), [init]);
  parser.finish();
});

test("rejects malformed JSON and malformed supported event payloads", () => {
  assert.throws(() => createAgyEventParser().push('{"event":"init",bad}\n'), /invalid Agy stream JSON on line 1/);
  assert.throws(() => createAgyEventParser().push('{"event":"init","init":null}\n'), /invalid Agy init payload/);
  assert.throws(() => createAgyEventParser().push('[]\n'), /invalid Agy stream event/);
});

test("rejects SUCCESS with no conversation ID or invalid turn count", () => {
  for (const conversation_id of ["", null, undefined]) {
    assert.throws(
      () => validateAgyResult({ event: "result", result: { ...success.result, conversation_id } }),
      /missing conversation_id/,
    );
  }
  for (const num_turns of [0, -1, 1.5, "3"]) {
    assert.throws(
      () => validateAgyResult({ event: "result", result: { ...success.result, num_turns } }),
      /invalid num_turns/,
    );
  }
});

test("rejects a resumed SUCCESS with a mismatched conversation ID", () => {
  assert.throws(
    () => validateAgyResult(success, { expectedConversationId: "other-conversation" }),
    /does not match resumed conversation/,
  );
});

test("preserves unknown event names and extra known-event fields", () => {
  const parser = createAgyEventParser();
  const unknown = { event: "future_event", future: { value: 1 } };
  const inheritedName = { event: "__proto__" };
  const tool = { event: "step_update", step_update: { step_type: "tool", tool_info: { name: "read_file" } }, extra: true };
  assert.deepEqual(parser.push(`${JSON.stringify(unknown)}\n${JSON.stringify(inheritedName)}\n${JSON.stringify(tool)}\n`), [unknown, inheritedName, tool]);
  parser.finish();
});

test("detects an unterminated JSON line at finish", () => {
  const parser = createAgyEventParser();
  parser.push(JSON.stringify(success));
  assert.throws(() => parser.finish(), /unterminated Agy stream JSON on line 1/);
});

test("rejects chunks after finish", () => {
  const parser = createAgyEventParser();
  parser.finish();
  assert.throws(() => parser.push("anything"), /already finished/);
});
