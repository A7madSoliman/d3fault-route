import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTierOf, isCodexModel, resolveCodexModels } from "../src/codex-models.mjs";
import { codexModels, startCodexProxy } from "../src/codex-proxy.mjs";
import { runConfigCli } from "../src/config-cli.mjs";
import { DEFAULT_MODEL_CONFIG } from "../src/default-config.mjs";
import { loadUserConfig } from "../src/user-config.mjs";

const catalogModels = [
  "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6.1-sol", "gpt-6-astra",
];
const requestBody = (model = "jev-router") => ({
  model,
  prompt_cache_key: `codex-config-${Math.random()}`,
  input: [
    { type: "additional_tools", role: "developer", tools: [{}] },
    { role: "user", content: "Review this change" },
  ],
});

async function fixture(t, { catalog = catalogModels } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "jev-codex-config-"));
  const configPath = join(directory, "config.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.includes("/models")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ models: catalog.map((slug) => ({
          slug, display_name: slug, visibility: "list", supported_in_api: true,
        })) }));
        return;
      }
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("content-type", "text/event-stream");
      res.end('event: response.created\ndata: {"type":"response.created"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed"}\n\n');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;

  async function request({ env = {}, route = async () => null, model = "jev-router" } = {}) {
    const proxy = await startCodexProxy({
      chatgptBaseURL: `${base}/backend-api/codex`,
      apiBaseURL: `${base}/v1`,
      configPath,
      env,
      route,
    });
    try {
      const url = `http://127.0.0.1:${proxy.port}`;
      const headers = { "chatgpt-account-id": "test", "content-type": "application/json" };
      await fetch(`${url}/models`, { headers });
      const response = await fetch(`${url}/responses`, {
        method: "POST", headers, body: JSON.stringify(requestBody(model)),
      });
      return { status: response.status, text: await response.text(), body: seen.at(-1) };
    } finally {
      proxy.close();
    }
  }

  async function configCli(args) {
    let output = "";
    let errors = "";
    await runConfigCli(args, {
      path: configPath,
      stdout: { write(value) { output += value; } },
      stderr: { write(value) { errors += value; } },
    });
    return { output, errors };
  }

  return { configPath, request, configCli, seen };
}

test("Codex model ownership accepts versioned catalog families and rejects other providers", () => {
  assert.equal(codexTierOf("gpt-6.1-sol"), "strong");
  assert.equal(codexTierOf("gpt-7-luna"), "fast");
  assert.equal(codexTierOf("gpt-7.2-terra"), "balanced");
  assert.equal(codexTierOf("gpt-7-astra"), "long");
  for (const model of ["claude-opus-5", "gemini-3.8-flash", "gpt-oss-120b", "unrelated-sol", "gpt-6-pro"]) {
    assert.equal(isCodexModel(model), false, model);
  }
  const mixed = new Map(["claude-opus-5", "gemini-3.8-flash", "gpt-oss-120b", "gpt-5.6-sol"]
    .map((slug) => [slug, { slug }]));
  assert.deepEqual(codexModels(mixed, resolveCodexModels(), true).map((model) => model.id), ["gpt-5.6-sol"]);
});

test("jev-config set and reset change the actual Codex proxy fallback", async (t) => {
  const f = await fixture(t);
  const set = await f.configCli(["set", "codex", "strong", "--model", "gpt-6.1-sol"]);
  assert.match(set.output, /updated codex\.strong/);
  assert.equal(loadUserConfig(f.configPath).codex.strong.model, "gpt-6.1-sol");
  assert.match((await f.configCli(["show"])).output, /strong\s+gpt-6\.1-sol/);
  const configured = await f.request();
  assert.equal(configured.body.model, "gpt-6.1-sol");
  assert.match(configured.text, /using gpt-6\.1-sol/);

  const reset = await f.configCli(["reset", "codex", "strong"]);
  assert.match(reset.output, /reset codex\.strong/);
  assert.equal(loadUserConfig(f.configPath).codex.strong.model, DEFAULT_MODEL_CONFIG.codex.strong.model);
  assert.match((await f.configCli(["show"])).output, /strong\s+gpt-5\.6-sol/);
  const restored = await f.request();
  assert.equal(restored.body.model, "gpt-5.6-sol");
  assert.match(restored.text, /using gpt-5\.6-sol/);
});

test("legacy Codex env wins over unified config and manual model bypasses Jev", async (t) => {
  const f = await fixture(t);
  await f.configCli(["set", "codex", "strong", "--model", "gpt-6.1-sol"]);
  const env = { JEV_CODEX_STRONG_MODEL: "gpt-5.6-sol" };
  const routed = await f.request({ env });
  assert.equal(routed.body.model, "gpt-5.6-sol");
  assert.match(routed.text, /using gpt-5\.6-sol/);
  let calls = 0;
  const manual = await f.request({
    env,
    model: "gpt-6.1-sol",
    route: async () => { calls++; return { choice: "gpt-5.6-sol" }; },
  });
  assert.equal(manual.body.model, "gpt-6.1-sol");
  assert.equal(calls, 0);
  assert.doesNotMatch(manual.text, /\[Jev\] routed/);
});

test("invalid legacy env override falls back to the valid unified Codex model", async (t) => {
  const f = await fixture(t);
  await f.configCli(["set", "codex", "strong", "--model", "gpt-6.1-sol"]);
  const result = await f.request({ env: { JEV_CODEX_STRONG_MODEL: "gemini-3.8-flash" } });
  assert.equal(result.body.model, "gpt-6.1-sol");
});

for (const model of ["claude-opus-5", "gemini-3.8-flash", "gpt-oss-120b", "unrelated-model"]) {
  test(`invalid ${model} is rejected by jev-config and ignored at runtime`, async (t) => {
    const f = await fixture(t);
    const rejected = await f.configCli(["set", "codex", "strong", "--model", model]);
    assert.match(rejected.errors, /unsupported Codex model/);
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    assert.equal(existsSync(f.configPath), false);
    writeFileSync(f.configPath, JSON.stringify({ codex: { strong: { model } } }));
    assert.equal(loadUserConfig(f.configPath).codex.strong.model, "gpt-5.6-sol");
    const routed = await f.request();
    assert.equal(routed.body.model, "gpt-5.6-sol");
  });
}

test("Jev receives only available Codex candidates even with a mixed catalog", async (t) => {
  const f = await fixture(t, { catalog: [
    "gpt-5.6-terra", "gpt-5.6-sol", "claude-opus-5", "gemini-3.8-flash", "gpt-oss-120b", "gpt-6-pro",
  ] });
  let candidates;
  const result = await f.request({ route: async ({ models }) => {
    candidates = models;
    return { choice: "claude-opus-5", confidence: 0.99 };
  } });
  assert.deepEqual(candidates.map(({ id }) => id), ["gpt-5.6-terra", "gpt-5.6-sol"]);
  assert(candidates.every(({ id }) => isCodexModel(id)));
  assert.equal(result.body.model, "gpt-5.6-sol");
});

test("a catalog with no Codex models stops routing before an upstream launch", async (t) => {
  const f = await fixture(t, { catalog: ["claude-opus-5", "gemini-3.8-flash", "gpt-oss-120b"] });
  let called = false;
  const result = await f.request({ route: async () => { called = true; return null; } });
  assert.equal(result.status, 503);
  assert.equal(result.body, undefined);
  assert.equal(called, false);
});

test("an unavailable configured model substitutes an available Codex model", async (t) => {
  const f = await fixture(t, { catalog: ["gpt-5.6-terra", "gpt-5.6-sol"] });
  await f.configCli(["set", "codex", "strong", "--model", "gpt-6.1-sol"]);
  const result = await f.request();
  assert.equal(result.body.model, "gpt-5.6-sol");
  assert.match(result.text, /using gpt-5\.6-sol/);
});

test("long tier remains unavailable without the legacy opt-in", async (t) => {
  const f = await fixture(t);
  let without;
  await f.request({ route: async ({ models }) => { without = models; return null; } });
  assert.equal(without.some(({ tier }) => tier === "long"), false);
  let withOptIn;
  await f.request({
    env: { JEV_ALLOW_FABLE: "1" },
    route: async ({ models }) => { withOptIn = models; return { choice: "gpt-6-astra", confidence: 0.95 }; },
  }).then((result) => assert.equal(result.body.model, "gpt-6-astra"));
  assert.equal(withOptIn.some(({ id, tier }) => id === "gpt-6-astra" && tier === "long"), true);
});
