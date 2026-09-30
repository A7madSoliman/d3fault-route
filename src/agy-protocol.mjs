import { StringDecoder } from "node:string_decoder";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEvent(line, lineNumber) {
  let event;
  try {
    event = JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid Agy stream JSON on line ${lineNumber}: ${error.message}`, { cause: error });
  }
  if (!isRecord(event) || typeof event.event !== "string") {
    throw new Error(`invalid Agy stream event on line ${lineNumber}`);
  }
  const payload = ["init", "step_update", "result"].includes(event.event) ? event.event : null;
  if (payload && !isRecord(event[payload])) {
    throw new Error(`invalid Agy ${event.event} payload on line ${lineNumber}`);
  }
  return event;
}

// Feed stdout chunks to push(); finish() rejects an unterminated JSON line.
// Neither method prints or interprets human-readable CLI output.
export function createAgyEventParser() {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineNumber = 0;
  let finished = false;

  return {
    push(chunk) {
      if (finished) throw new Error("Agy stream parser is already finished");
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      const events = [];
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        lineNumber += 1;
        if (line.trim()) events.push(parseEvent(line, lineNumber));
      }
      return events;
    },
    finish() {
      if (finished) throw new Error("Agy stream parser is already finished");
      finished = true;
      pending += decoder.end();
      if (pending.trim()) {
        throw new Error(`unterminated Agy stream JSON on line ${lineNumber + 1}`);
      }
      return [];
    },
  };
}

// A non-success result is a completed protocol event, never a successful turn.
// Keep the raw result so future Agy fields remain available to the session layer.
export function validateAgyResult(event, { expectedConversationId } = {}) {
  if (!isRecord(event) || event.event !== "result" || !isRecord(event.result)) {
    throw new Error("expected an Agy result event");
  }
  const result = event.result;
  if (typeof result.status !== "string" || !result.status) {
    throw new Error("Agy result is missing status");
  }
  if (result.status !== "SUCCESS") {
    return {
      ok: false,
      status: result.status,
      conversationId: result.conversation_id ?? null,
      response: result.response ?? "",
      error: result.error ?? null,
      numTurns: result.num_turns ?? null,
      usage: result.usage,
      result,
    };
  }
  if (typeof result.conversation_id !== "string" || !result.conversation_id.trim()) {
    throw new Error("successful Agy result is missing conversation_id");
  }
  if (expectedConversationId !== undefined && result.conversation_id !== expectedConversationId) {
    throw new Error("Agy result conversation_id does not match resumed conversation");
  }
  if (!Number.isInteger(result.num_turns) || result.num_turns < 1) {
    throw new Error("successful Agy result has invalid num_turns");
  }
  if (typeof result.response !== "string") {
    throw new Error("successful Agy result has invalid response");
  }
  return {
    ok: true,
    status: result.status,
    conversationId: result.conversation_id,
    response: result.response,
    error: null,
    numTurns: result.num_turns,
    usage: result.usage,
    result,
  };
}
