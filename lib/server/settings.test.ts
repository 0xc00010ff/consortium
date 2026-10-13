import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySettingsUpdate,
  hasAnyModelKey,
  makersWithKeys,
  parseSettingsUpdate,
  readSettingsFile,
  resolveKey,
  resolveKeys,
  settingsPath,
  writeSettingsFile,
} from "./settings";
import { isolateSettings, removeSettingsDirs } from "./settingsHome.testkit";

const saved = { ...process.env };
let home: string;

beforeEach(() => {
  home = isolateSettings();
});

afterEach(() => {
  process.env = { ...saved };
  removeSettingsDirs();
});

describe("the settings file", () => {
  it("lives in CONSORTIUM_HOME when set, and in ~/.consortium otherwise", () => {
    expect(settingsPath()).toBe(path.join(home, "settings.json"));
    expect(settingsPath({})).toBe(path.join(os.homedir(), ".consortium", "settings.json"));
  });

  it("reads as empty when the file is missing or malformed", () => {
    expect(readSettingsFile()).toEqual({ keys: {}, toolPaths: {} });
    writeFileSync(settingsPath(), "{ not json");
    expect(readSettingsFile()).toEqual({ keys: {}, toolPaths: {} });
    writeFileSync(settingsPath(), JSON.stringify({ keys: { openai: 42, xai: " xai-1 ", other: "x" }, toolPaths: "nope" }));
    expect(readSettingsFile()).toEqual({ keys: { xai: "xai-1" }, toolPaths: {} });
  });

  it("round-trips, with mode 0600 for the file and 0700 for a new folder", () => {
    const dir = path.join(home, "nested");
    process.env.CONSORTIUM_HOME = dir;
    const settings = { keys: { gateway: "vck_abc123", anthropic: "sk-ant-1" }, toolPaths: { codex: "/opt/codex" } };
    writeSettingsFile(settings);
    expect(readSettingsFile()).toEqual(settings);
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual(settings);
  });

  it("tightens the mode of a file that already existed", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(settingsPath(), "{}", { mode: 0o644 });
    writeSettingsFile({ keys: { openai: "sk-1" }, toolPaths: {} });
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
  });
});

describe("settings updates", () => {
  it("trims values, treats empty strings as null, and ignores unknown fields", () => {
    const parsed = parseSettingsUpdate({
      keys: { gateway: "  vck_1  ", openai: "", mistral: "x" },
      toolPaths: { claude: null },
      theme: "dark",
    });
    expect(parsed).toEqual({ ok: true, update: { keys: { gateway: "vck_1", openai: null }, toolPaths: { claude: null } } });
  });

  it("rejects values that are too long, of the wrong type, or contain spaces", () => {
    expect(parseSettingsUpdate({ keys: { gateway: "a".repeat(513) } })).toEqual({
      ok: false,
      error: "The gateway key is longer than 512 characters.",
    });
    expect(parseSettingsUpdate({ keys: { gateway: "a".repeat(512) } }).ok).toBe(true);
    expect(parseSettingsUpdate({ keys: { openai: 5 } })).toEqual({ ok: false, error: "The OpenAI key must be a string or null." });
    expect(parseSettingsUpdate({ keys: { xai: "two words" } }).ok).toBe(false);
    expect(parseSettingsUpdate({ keys: "x" }).ok).toBe(false);
    expect(parseSettingsUpdate([]).ok).toBe(false);
    expect(parseSettingsUpdate(null).ok).toBe(false);
  });

  it("requires a full path for a tool, and expands ~", () => {
    expect(parseSettingsUpdate({ toolPaths: { codex: "bin/codex" } })).toEqual({
      ok: false,
      error: "The Codex path must be a full path, such as /usr/local/bin/codex.",
    });
    expect(parseSettingsUpdate({ toolPaths: { claude: "~/bin/claude" } })).toEqual({
      ok: true,
      update: { toolPaths: { claude: path.join(os.homedir(), "bin/claude") } },
    });
  });

  it("sets, clears and leaves values alone", () => {
    const current = { keys: { gateway: "g", openai: "o" }, toolPaths: { claude: "/a/claude" } };
    expect(applySettingsUpdate(current, { keys: { gateway: null, xai: "x" }, toolPaths: { codex: "/b/codex" } })).toEqual({
      keys: { openai: "o", xai: "x" },
      toolPaths: { claude: "/a/claude", codex: "/b/codex" },
    });
    expect(applySettingsUpdate(current, {})).toEqual(current);
  });
});

describe("key resolution", () => {
  it("prefers the settings file, then the environment", () => {
    const settings = { keys: { openai: "sk-from-file" }, toolPaths: {} };
    const env = { OPENAI_API_KEY: "sk-from-env", AI_GATEWAY_API_KEY: "vck-env", XAI_API_KEY: "  " };
    expect(resolveKey("openai", settings, env)).toEqual({ value: "sk-from-file", source: "settings" });
    expect(resolveKey("gateway", settings, env)).toEqual({ value: "vck-env", source: "env" });
    expect(resolveKey("xai", settings, env)).toBeNull();
  });

  it("reads Google from GOOGLE_GENERATIVE_AI_API_KEY first, then GEMINI_API_KEY", () => {
    const empty = { keys: {}, toolPaths: {} };
    expect(resolveKey("google", empty, { GEMINI_API_KEY: "gem" })).toEqual({ value: "gem", source: "env" });
    expect(resolveKey("google", empty, { GEMINI_API_KEY: "gem", GOOGLE_GENERATIVE_AI_API_KEY: "ggai" })).toEqual({
      value: "ggai",
      source: "env",
    });
  });

  it("reads the saved file by default and lists the makers with keys", () => {
    writeSettingsFile({ keys: { anthropic: "sk-ant" }, toolPaths: {} });
    process.env.XAI_API_KEY = "xai-env";
    const keys = resolveKeys();
    expect(keys.anthropic).toEqual({ value: "sk-ant", source: "settings" });
    expect(keys.gateway).toBeNull();
    expect(makersWithKeys(keys)).toEqual(["anthropic", "xai"]);
    expect(hasAnyModelKey(keys)).toBe(true);
    expect(hasAnyModelKey(resolveKeys({ keys: {}, toolPaths: {} }, {}))).toBe(false);
  });
});
