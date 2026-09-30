import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

// Search all PATH entries for a native executable before considering script shims.
export function resolveCliExecutable(name, {
  pathValue = process.env.PATH,
  platform = process.platform,
  allowPowerShellScript = false,
  accessFile = accessSync,
} = {}) {
  const windows = platform === "win32";
  const directories = (pathValue ?? "").split(windows ? ";" : ":").filter(Boolean);
  const find = (extension) => {
    for (const directory of directories) {
      const file = join(directory.replace(/^"|"$/g, ""), `${name}${extension}`);
      try {
        accessFile(file, windows ? constants.F_OK : constants.X_OK);
        return file;
      } catch {
        // Continue searching PATH.
      }
    }
    return null;
  };

  for (const extension of windows ? [".exe", ".com"] : [""]) {
    const file = find(extension);
    if (file) return { file, prefix: [] };
  }
  if (windows && allowPowerShellScript) {
    const script = find(".ps1");
    if (script) return { file: "powershell.exe", prefix: ["-NoProfile", "-File", script] };
  }
  if (windows) {
    for (const extension of [".cmd", ".bat"]) {
      const unsafeShim = find(extension);
      if (unsafeShim) return { unsafeShim };
    }
  }
  return null;
}

export function spawnCliExecutable(command, args, { spawnProcess = spawn, env = process.env } = {}) {
  if (!command?.file || command.unsafeShim || /\.(?:cmd|bat)$/i.test(command.file)) {
    throw new Error("a native executable is required for safe launch; Windows .cmd/.bat shims are unsupported");
  }
  return spawnProcess(command.file, [...(command.prefix ?? []), ...args], {
    stdio: "inherit",
    shell: false,
    env,
  });
}
