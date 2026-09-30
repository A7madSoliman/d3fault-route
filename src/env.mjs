import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile } from "./atomic-write.mjs";

export function envFilePath(home = homedir()) {
  return join(home, ".jev-router.env");
}

export function loadJevEnv(path = envFilePath(), env = process.env) {
  if (!existsSync(path)) {
    return env;
  }

  const content = readFileSync(path, "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();

    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");

    if (!key || env[key]) {
      continue;
    }

    env[key] = value;
  }

  return env;
}

export function hasJevApiKey(path = envFilePath(), env = process.env) {
  const loadedEnv = { ...env };

  loadJevEnv(path, loadedEnv);

  return Boolean(loadedEnv.JEV_API_KEY || loadedEnv.TYPESAFE_API_KEY);
}

export function writeJevApiKey(apiKey, path = envFilePath()) {
  if (typeof apiKey !== "string" || /[\r\n]/.test(apiKey)) {
    throw new Error("JEV API key must be a single line without newline characters");
  }

  const value = apiKey.trim();

  if (!value) {
    throw new Error("JEV API key cannot be empty");
  }

  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const newline = content.includes("\r\n") ? "\r\n" : content.includes("\r") ? "\r" : "\n";
  const parts = content.split(/(\r\n|\n|\r)/);
  let found = false;
  let updated = "";

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const ending = parts[index + 1] ?? "";
    const match = /^([ \t]*JEV_API_KEY[ \t]*=)/.exec(line);
    if (match) {
      if (!found) updated += `${match[1]}${value}${ending}`;
      found = true;
    } else {
      updated += line + ending;
    }
  }

  if (!found) {
    if (updated && !/[\r\n]$/.test(updated)) updated += newline;
    updated += `JEV_API_KEY=${value}${newline}`;
  }

  atomicWriteFile(path, updated, 0o600);

  return path;
}
