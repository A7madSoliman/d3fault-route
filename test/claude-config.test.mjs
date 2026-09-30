import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isClaudeModel, resolveClaudeModels, tierOf } from "../src/claude-models.mjs";
import { claudeModels, startProxy } from "../src/proxy.mjs";
import { runConfigCli } from "../src/config-cli.mjs";
import { loadUserConfig } from "../src/user-config.mjs";
import { DEFAULT_MODEL_CONFIG } from "../src/default-config.mjs";
import { STATUS_DIR } from "../src/status.mjs";

const defaultCatalog = [
  "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-fable-5-1",
];

async function fixture(t, catalog = defaultCatalog) {
  const directory = mkdtempSync(join(tmpdir(), "jev-claude-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: catalog.map((id) => ({ id, display_name: id })) }));
        return;
      }
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ type: "message", model: seen.at(-1).model }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;

  async function cli(args) {
    let output = "";
    let errors = "";
    await runConfigCli(args, {
      path: configPath,
      stdout: { write(value) { output += value; } },
      stderr: { write(value) { errors += value; } },
    });
    return { output, errors };
  }

  async function proxy({ env = {}, route = async () => null } = {}) {
    const opened = await startProxy({ upstreamURL, configPath, env, route });
    t.after(opened.close);
    const url = `http://127.0.0.1:${opened.port}`;
    await fetch(`${url}/v1/models`);
    return async (body = {}) => {
      const prior = seen.length;
      const session = `claude-config-${randomUUID()}`;
      const metadata = body.metadata ?? { user_id: JSON.stringify({ session_id: session }) };
      if (!body.metadata) t.after(() => rmSync(join(STATUS_DIR, `${session}.json`), { force: true }));
      const response = await fetch(`${url}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "jev-router",
          tools: [{ name: "Bash" }],
          messages: [{ role: "user", content: `Check this change ${randomUUID()}` }],
          metadata,
          ...body,
        }),
      });
      return { status: response.status, body: seen.length > prior ? seen.at(-1) : null };
    };
  }

  return { configPath, seen, cli, proxy };
}

test("Claude ownership recognizes represented versions without admitting other providers", () => {
  assert.equal(tierOf("claude-sonnet-4-6"), "balanced");
  assert.equal(tierOf("claude-fable-5-1[1m]"), "long");
  for (const id of ["gpt-5.6-sol", "gemini-3.8-flash", "gpt-oss-120b", "not-claude-opus-5", "claude-opus-other"]) {
    assert.equal(isClaudeModel(id), false, id);
  }
  assert.equal(resolveClaudeModels().strong, "claude-opus-5");
});

test("jev-config set and reset change the Claude model sent upstream", async (t) => {
  const f = await fixture(t);
  assert.match((await f.cli(["set", "claude", "strong", "--model", "claude-opus-4-8"])).output, /updated claude\.strong/);
  assert.match((await f.cli(["show"])).output, /strong\s+claude-opus-4-8/);
  const configured = await f.proxy();
  assert.equal((await configured()).body.model, "claude-opus-4-8");
  assert.match((await f.cli(["reset", "claude", "strong"])).output, /reset claude\.strong/);
  assert.equal(loadUserConfig(f.configPath).claude.strong.model, DEFAULT_MODEL_CONFIG.claude.strong.model);
  const restored = await f.proxy();
  assert.equal((await restored()).body.model, "claude-opus-5");
});

for (const id of ["gpt-5.6-sol", "gemini-3.8-flash", "gpt-oss-120b", "claude-sonnet-5", "other-model"]) {
  test(`invalid Claude strong override ${id} is rejected and ignored at runtime`, async (t) => {
    const f = await fixture(t);
    const result = await f.cli(["set", "claude", "strong", "--model", id]);
    assert.match(result.errors, /unsupported Claude model/);
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    assert.equal(existsSync(f.configPath), false);
    writeFileSync(f.configPath, JSON.stringify({ claude: { strong: { model: id } } }));
    assert.equal(loadUserConfig(f.configPath).claude.strong.model, "claude-opus-5");
    const send = await f.proxy();
    assert.equal((await send()).body.model, "claude-opus-5");
  });
}

test("Jev sees Claude-only catalog candidates and cannot select a foreign model", async (t) => {
  const f = await fixture(t, ["claude-opus-5", "claude-sonnet-5", "gpt-5.6-sol", "gemini-3.8-flash", "gpt-oss-120b"]);
  let candidates;
  const send = await f.proxy({ route: async ({ models }) => {
    candidates = models;
    return { choice: "gpt-5.6-sol", confidence: 0.99, ms: 1 };
  } });
  assert.equal((await send()).body.model, "claude-opus-5");
  assert.deepEqual(candidates.map(({ id }) => id), ["claude-opus-5", "claude-sonnet-5"]);
  assert(candidates.every(({ id }) => isClaudeModel(id)));
  assert.deepEqual(claudeModels([{ id: "gpt-oss-120b" }, { id: "claude-opus-5" }], resolveClaudeModels(), true)
    .map(({ id }) => id), ["claude-opus-5"]);
});

test("an unavailable configured Claude model falls back to an available same-tier model", async (t) => {
  const f = await fixture(t, ["claude-opus-5", "claude-sonnet-5"]);
  await f.cli(["set", "claude", "strong", "--model", "claude-opus-4-8"]);
  const send = await f.proxy();
  assert.equal((await send()).body.model, "claude-opus-5");
});

test("Claude manual model passes through and continuation remains pinned", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const send = await f.proxy({ route: async () => { calls++; return { choice: "claude-sonnet-5", confidence: 0.95, ms: 1 }; } });
  const session = `claude-config-${randomUUID()}`;
  t.after(() => rmSync(join(STATUS_DIR, `${session}.json`), { force: true }));
  const first = { model: "jev-router", metadata: { user_id: JSON.stringify({ session_id: session }) },
    messages: [{ role: "user", content: "First turn" }] };
  assert.equal((await send(first)).body.model, "claude-sonnet-5");
  const continuation = { ...first, messages: [first.messages[0], { role: "assistant", content: "working" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "done" }] }] };
  assert.equal((await send(continuation)).body.model, "claude-sonnet-5");
  assert.equal(calls, 1);
  assert.equal((await send({ ...first, model: "claude-opus-4-8" })).body.model, "claude-opus-4-8");
  assert.equal(calls, 1);
});

test("Claude long tier requires the legacy opt-in", async (t) => {
  const f = await fixture(t);
  let without;
  const normal = await f.proxy({ route: async ({ models }) => { without = models; return null; } });
  await normal();
  assert.equal(without.some(({ tier }) => tier === "long"), false);
  let withOptIn;
  const enabled = await f.proxy({ env: { JEV_ALLOW_FABLE: "1" }, route: async ({ models }) => {
    withOptIn = models; return { choice: "claude-fable-5-1", confidence: 0.95, ms: 1 };
  } });
  assert.equal((await enabled()).body.model, "claude-fable-5-1");
  assert.equal(withOptIn.some(({ tier }) => tier === "long"), true);
});

test("a catalog with no Claude models fails closed", async (t) => {
  const f = await fixture(t, ["gpt-oss-120b", "gemini-3.8-flash"]);
  let called = false;
  const send = await f.proxy({ route: async () => { called = true; return null; } });
  const result = await send();
  assert.equal(result.status, 503);
  assert.equal(result.body, null);
  assert.equal(called, false);
});
