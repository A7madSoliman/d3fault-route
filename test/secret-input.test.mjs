import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { readHiddenInput } from "../src/secret-input.mjs";

function createFakeStdin({ isTTY = true } = {}) {
  const stdin = new EventEmitter();

  stdin.isTTY = isTTY;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.setEncoding = () => {};

  return stdin;
}

test("rejects hidden input outside an interactive terminal", async () => {
  const stdin = createFakeStdin({
    isTTY: false,
  });

  const stdout = {
    write() {},
  };

  await assert.rejects(
    readHiddenInput("Key: ", {
      stdin,
      stdout,
    }),
    /interactive terminal/,
  );
});

test("reads hidden input without echoing the secret", async () => {
  const stdin = createFakeStdin();

  let output = "";

  const stdout = {
    write(value) {
      output += value;
    },
  };

  const resultPromise = readHiddenInput("Key: ", {
    stdin,
    stdout,
  });

  stdin.emit("data", "secret-key");
  stdin.emit("data", "\r");

  const result = await resultPromise;

  assert.equal(result, "secret-key");
  assert.equal(output, "Key: **********\n");
  assert.equal(output.includes("secret-key"), false);
});

test("supports backspace while reading hidden input", async () => {
  const stdin = createFakeStdin();

  const stdout = {
    write() {},
  };

  const resultPromise = readHiddenInput("Key: ", {
    stdin,
    stdout,
  });

  stdin.emit("data", "abc");
  stdin.emit("data", "\b");
  stdin.emit("data", "d");
  stdin.emit("data", "\r");

  assert.equal(await resultPromise, "abd");
});

test("rejects when hidden input is cancelled", async () => {
  const stdin = createFakeStdin();

  const stdout = {
    write() {},
  };

  const resultPromise = readHiddenInput("Key: ", {
    stdin,
    stdout,
  });

  stdin.emit("data", "\u0003");

  await assert.rejects(resultPromise, /input cancelled/);
});
