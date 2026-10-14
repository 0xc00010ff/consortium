// The host's own settings: API keys, tool paths, and whether the first-run
// setup is done, saved in
// ~/.consortium/settings.json (or $CONSORTIUM_HOME/settings.json). The file is
// read fresh on every request, since it is small and the settings modal can
// change it at any time.
//
// A key saved in the file wins over the same key in the environment, so the
// host can override a key from .env.local without editing it.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KEY_NAMES, type KeyName, type Maker, type SettingsUpdate } from "@/lib/types";
import { isRecord, writeFileAtomic } from "./files";

export type ToolPathName = "claude" | "codex";
export const TOOL_PATH_NAMES: ToolPathName[] = ["claude", "codex"];

export interface SettingsFile {
  keys: Partial<Record<KeyName, string>>;
  toolPaths: Partial<Record<ToolPathName, string>>;
  // true once the host finished or skipped the first-run setup. The file
  // always reads with a value; a missing value means false.
  setupDone?: boolean;
}

// The environment to read: process.env, or a plain object in tests.
export type Env = Record<string, string | undefined>;

export const MAX_VALUE_LENGTH = 512;

// The environment variables read for each key, in order.
export const KEY_ENV: Record<KeyName, string[]> = {
  gateway: ["AI_GATEWAY_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  xai: ["XAI_API_KEY"],
};

// ---------- The file ----------

export function settingsDir(env: Env = process.env): string {
  return env.CONSORTIUM_HOME?.trim() || path.join(os.homedir(), ".consortium");
}

export function settingsPath(env: Env = process.env): string {
  return path.join(settingsDir(env), "settings.json");
}

function emptySettings(): SettingsFile {
  return { keys: {}, toolPaths: {}, setupDone: false };
}

// A missing or malformed file reads as empty settings, with the setup not
// done. Values of the wrong type are dropped.
export function readSettingsFile(file: string = settingsPath()): SettingsFile {
  let raw: unknown;
  try {
    // The file is outside the project, so the build should not trace it.
    raw = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
  } catch {
    return emptySettings();
  }
  const settings = emptySettings();
  if (!isRecord(raw)) return settings;
  if (isRecord(raw.keys)) {
    for (const name of KEY_NAMES) {
      const value = raw.keys[name];
      if (typeof value === "string" && value.trim()) settings.keys[name] = value.trim();
    }
  }
  if (isRecord(raw.toolPaths)) {
    for (const name of TOOL_PATH_NAMES) {
      const value = raw.toolPaths[name];
      if (typeof value === "string" && value.trim()) settings.toolPaths[name] = value.trim();
    }
  }
  if (typeof raw.setupDone === "boolean") settings.setupDone = raw.setupDone;
  return settings;
}

// Writes the file with mode 0600, creating its folder with mode 0700 when
// needed. An existing folder keeps its mode. The new content goes to a
// temporary file first, so a failed write never leaves half a file.
export function writeSettingsFile(settings: SettingsFile, file: string = settingsPath()): void {
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

// ---------- Updates ----------

export type ParsedUpdate = { ok: true; update: SettingsUpdate } | { ok: false; error: string };

const KEY_LABELS: Record<KeyName, string> = {
  gateway: "The gateway key",
  anthropic: "The Anthropic key",
  openai: "The OpenAI key",
  google: "The Google key",
  xai: "The xAI key",
};

// Checks a PUT body. Strings are trimmed, an empty string or null clears the
// value, setupDone must be true or false, and unknown fields are ignored.
export function parseSettingsUpdate(body: unknown): ParsedUpdate {
  if (!isRecord(body)) return { ok: false, error: "The settings must be a JSON object." };
  const update: SettingsUpdate = {};

  if (body.keys !== undefined) {
    if (!isRecord(body.keys)) return { ok: false, error: "keys must be an object." };
    const keys: NonNullable<SettingsUpdate["keys"]> = {};
    for (const name of KEY_NAMES) {
      if (!(name in body.keys) || body.keys[name] === undefined) continue;
      const checked = checkValue(body.keys[name], KEY_LABELS[name]);
      if (!checked.ok) return checked;
      if (checked.value !== null && /\s/.test(checked.value)) {
        return { ok: false, error: `${KEY_LABELS[name]} cannot contain spaces or line breaks.` };
      }
      keys[name] = checked.value;
    }
    update.keys = keys;
  }

  if (body.toolPaths !== undefined) {
    if (!isRecord(body.toolPaths)) return { ok: false, error: "toolPaths must be an object." };
    const toolPaths: NonNullable<SettingsUpdate["toolPaths"]> = {};
    for (const name of TOOL_PATH_NAMES) {
      if (!(name in body.toolPaths) || body.toolPaths[name] === undefined) continue;
      const label = name === "claude" ? "The Claude Code path" : "The Codex path";
      const checked = checkValue(body.toolPaths[name], label);
      if (!checked.ok) return checked;
      let value = checked.value;
      if (value !== null && (value === "~" || value.startsWith("~/"))) value = path.join(os.homedir(), value.slice(1));
      if (value !== null && !path.isAbsolute(value)) {
        return { ok: false, error: `${label} must be a full path, such as /usr/local/bin/${name}.` };
      }
      toolPaths[name] = value;
    }
    update.toolPaths = toolPaths;
  }

  if (body.setupDone !== undefined) {
    if (typeof body.setupDone !== "boolean") return { ok: false, error: "setupDone must be true or false." };
    update.setupDone = body.setupDone;
  }

  return { ok: true, update };
}

function checkValue(value: unknown, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${label} must be a string or null.` };
  const trimmed = value.trim();
  if (trimmed.length > MAX_VALUE_LENGTH) {
    return { ok: false, error: `${label} is longer than ${MAX_VALUE_LENGTH} characters.` };
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, error: `${label} contains a control character.` };
  return { ok: true, value: trimmed || null };
}

// Applies an update to the saved settings. A null or empty value removes the
// setting; a missing field is left alone.
export function applySettingsUpdate(current: SettingsFile, update: SettingsUpdate): SettingsFile {
  const next: SettingsFile = {
    keys: { ...current.keys },
    toolPaths: { ...current.toolPaths },
    setupDone: update.setupDone ?? (current.setupDone === true),
  };
  for (const name of KEY_NAMES) {
    if (!update.keys || !(name in update.keys)) continue;
    const value = update.keys[name];
    if (value) next.keys[name] = value;
    else delete next.keys[name];
  }
  for (const name of TOOL_PATH_NAMES) {
    if (!update.toolPaths || !(name in update.toolPaths)) continue;
    const value = update.toolPaths[name];
    if (value) next.toolPaths[name] = value;
    else delete next.toolPaths[name];
  }
  return next;
}

// ---------- Key resolution ----------

export interface ResolvedKey {
  value: string;
  source: "settings" | "env";
}

export type ResolvedKeys = Record<KeyName, ResolvedKey | null>;

export function resolveKey(
  name: KeyName,
  settings: SettingsFile = readSettingsFile(),
  env: Env = process.env,
): ResolvedKey | null {
  const saved = settings.keys[name]?.trim();
  if (saved) return { value: saved, source: "settings" };
  for (const variable of KEY_ENV[name]) {
    const value = env[variable]?.trim();
    if (value) return { value, source: "env" };
  }
  return null;
}

export function resolveKeys(
  settings: SettingsFile = readSettingsFile(),
  env: Env = process.env,
): ResolvedKeys {
  const keys = {} as ResolvedKeys;
  for (const name of KEY_NAMES) keys[name] = resolveKey(name, settings, env);
  return keys;
}

// The makers whose models can run directly on their own API key.
export const PROVIDER_MAKERS: Maker[] = ["anthropic", "openai", "google", "xai"];

export function makersWithKeys(keys: ResolvedKeys): Maker[] {
  return PROVIDER_MAKERS.filter((maker) => keys[maker] !== null);
}

export function gatewayKey(keys: ResolvedKeys = resolveKeys()): string | null {
  return keys.gateway?.value ?? null;
}

// True when any key can run gateway models: the gateway key, or a provider key.
export function hasAnyModelKey(keys: ResolvedKeys = resolveKeys()): boolean {
  return KEY_NAMES.some((name) => keys[name] !== null);
}
