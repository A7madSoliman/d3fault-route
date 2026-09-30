import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveCliExecutable, spawnCliExecutable } from "../src/cli-launch.mjs";
import { resolveCodex } from "../src/codex-cli.mjs";

const shellMetacharacters = ["&", "|", "<", ">", "^", "%", "!", "(", ")", ";", "a & b", "100% literal!"];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "jev-cli-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shim = join(root, "shim");
  const native = join(root, "native");
  mkdirSync(shim);
  mkdirSync(native);
  const touch = (dir, name) => {
    const file = join(dir, name);
    writeFileSync(file, "");
    return file;
  };
  return { shim, native, touch };
}

for (const name of ["claude", "codex"]) {
  const resolve = (name === "claude")
    ? (pathValue) => resolveCliExecutable("claude", { pathValue, platform: "win32" })
    : (pathValue) => resolveCodex(pathValue, "win32");

  test(`${name}: native executable wins over an earlier Windows batch shim`, (t) => {
    const { shim, native, touch } = fixture(t);
    touch(shim, `${name}.cmd`);
    const executable = touch(native, `${name}.exe`);
    assert.deepEqual(resolve(`${shim};${native}`), { file: executable, prefix: [] });
  });

  for (const extension of ["cmd", "bat"]) {
    test(`${name}: ${extension}-only installation fails closed`, (t) => {
      const { shim, touch } = fixture(t);
      const file = touch(shim, `${name}.${extension}`);
      const command = resolve(shim);
      assert.deepEqual(command, { unsafeShim: file });
      let spawned = false;
      assert.throws(
        () => spawnCliExecutable(command, ["ordinary", ...shellMetacharacters], {
          spawnProcess: () => { spawned = true; },
        }),
        /native executable is required.*\.cmd\/\.bat/,
      );
      assert.equal(spawned, false);
    });
  }

  test(`${name}: ordinary and shell metacharacter arguments reach the child literally`, async (t) => {
    const { native, touch } = fixture(t);
    const executable = touch(native, `${name}.exe`);
    const command = resolve(native);
    assert.equal(command.file, executable);
    const args = ["--model", "native-model", "--", "ordinary prompt", ...shellMetacharacters];
    let captured;
    const child = spawnCliExecutable(command, args, {
      spawnProcess(file, passedArgs, options) {
        captured = { file, passedArgs, options };
        // Run Node itself as the harmless child to verify OS-level literal argument delivery.
        return spawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...passedArgs], {
          ...options,
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
    });
    const output = [];
    const diagnostics = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => diagnostics.push(chunk));
    const exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    assert.equal(exitCode, 0, Buffer.concat(diagnostics).toString());
    assert.equal(captured.file, executable);
    assert.deepEqual(captured.passedArgs, args);
    assert.equal(captured.options.shell, false);
    assert.equal(captured.options.stdio, "inherit");
    assert.deepEqual(JSON.parse(Buffer.concat(output).toString()), args);
  });
}

test("Codex retains its PowerShell script fallback without a shell", (t) => {
  const { shim, touch } = fixture(t);
  const script = touch(shim, "codex.ps1");
  touch(shim, "codex.cmd");
  const command = resolveCodex(shim, "win32");
  assert.deepEqual(command, { file: "powershell.exe", prefix: ["-NoProfile", "-File", script] });
  let captured;
  spawnCliExecutable(command, ["--help", "a & b"], {
    spawnProcess: (file, args, options) => { captured = { file, args, options }; },
  });
  assert.deepEqual(captured.args, ["-NoProfile", "-File", script, "--help", "a & b"]);
  assert.equal(captured.options.shell, false);
});
