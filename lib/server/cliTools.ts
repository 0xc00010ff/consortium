// Finds the Claude Code and Codex command line tools on this machine, and
// the model and thinking level each one uses by default. A tool that is found
// appears in the model list as "cli/claude-code" or "cli/codex". Calls to it
// run on the host's own subscription through lib/server/cli.ts.
//
// Detection only looks at files. It never starts either tool. A path saved
// in the settings file wins over CONSORTIUM_CLAUDE_BIN and
// CONSORTIUM_CODEX_BIN, which win over the search.
//
// Thinking levels: Claude Code takes the same levels for every model, the
// ones `claude --help` lists for --effort. Codex lists the levels of each
// model in its models_cache.json, and the list falls back to low to max when
// that file is missing.

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelInfo, ToolModel } from "@/lib/types";
import { readSettingsFile, type SettingsFile } from "./settings";

export const CLAUDE_CODE_ID = "cli/claude-code";
export const CODEX_ID = "cli/codex";
export type CliToolId = typeof CLAUDE_CODE_ID | typeof CODEX_ID;

// The environment to read: process.env, or a plain object in tests.
type Env = Record<string, string | undefined>;

export const DEFAULT_MODEL_LABEL = "default model";

// The thinking levels a model offers, and its default level where known.
export type ThinkingInfo = Pick<ModelInfo, "thinkingLevels" | "defaultThinking">;

export interface CliTool {
  id: CliToolId;
  bin: string; // absolute path of the command
  configuredModel: string | null; // from the tool's settings, before formatting
  // The thinking level from the tool's settings, used when none is chosen.
  configuredThinking?: string | null;
  // Codex: the levels of each model, keyed by model id, from models_cache.json.
  modelThinking?: Record<string, ThinkingInfo>;
}

export function isCliModelId(id: string): boolean {
  return id.startsWith("cli/");
}

// A tool model id becomes a command line argument, so it must not start with
// "-" or contain spaces or quotes.
const TOOL_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function isToolModelId(value: unknown): value is string {
  return typeof value === "string" && TOOL_MODEL_PATTERN.test(value);
}

// A thinking level becomes a command line argument and a TOML string, so it
// is a short lowercase word such as "high" or "xhigh".
const THINKING_LEVEL_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;

export function isThinkingLevel(value: unknown): value is string {
  return typeof value === "string" && THINKING_LEVEL_PATTERN.test(value);
}

// The levels Claude Code takes for --effort, the same for every model.
export const CLAUDE_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// The levels Codex models offer when models_cache.json cannot be read.
export const CODEX_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// ---------- Model choices ----------

// The aliases Claude Code accepts for --model. Each one runs the latest
// model of that tier.
export const CLAUDE_TOOL_MODELS: ToolModel[] = [
  { id: "fable", name: "Fable" },
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
];

// The models Codex accepts with a ChatGPT login, in the order the Codex
// command lists them, without the ones it marks as legacy. Codex does not
// take every gateway id, since its own list often lags behind the gateway's,
// so these ids come from Codex itself.
export const CODEX_TOOL_MODELS: ToolModel[] = [
  { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
];

// The models Codex can run with: the given list, then the model from
// config.toml when it is not already listed. Ids Codex could not take as an
// argument are left out.
export function codexToolModels(openai: ToolModel[], configuredModel: string | null): ToolModel[] {
  const list: ToolModel[] = [];
  for (const model of openai) {
    if (isToolModelId(model.id) && !list.some((m) => m.id === model.id)) list.push(model);
  }
  if (isToolModelId(configuredModel) && !list.some((m) => m.id === configuredModel)) {
    list.push({ id: configuredModel, name: configuredModel });
  }
  return list;
}

// ---------- Finding the commands ----------

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// PATH first, then the usual install places. The folder that holds this
// Node binary is also npm's global bin folder for most installs.
function searchDirs(env: Env): string[] {
  const home = os.homedir();
  const fromPath = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extra = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global", "bin"),
    path.dirname(process.execPath),
  ];
  if (env.npm_config_prefix) extra.push(path.join(env.npm_config_prefix, "bin"));
  return [...new Set([...fromPath, ...extra])];
}

function findInDirs(name: string, env: Env): string | null {
  for (const dir of searchDirs(env)) {
    const file = path.join(dir, name);
    if (isExecutableFile(file)) return file;
  }
  return null;
}

// The Codex desktop app ships the command line tool inside its bundle.
const CODEX_APP_BINS = [
  "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/MacOS/codex",
];

function overrideBin(value: string | undefined): string | null {
  const bin = value?.trim();
  return bin && isExecutableFile(bin) ? bin : null;
}

// The tool paths saved in the settings file.
export type ToolPaths = SettingsFile["toolPaths"];

// A path that is set but is not an executable file means the tool is not
// found. The search does not run in its place, so a wrong path shows.
export function findClaudeBin(env: Env = process.env, paths: ToolPaths = {}): string | null {
  if (paths.claude?.trim()) return overrideBin(paths.claude);
  if (env.CONSORTIUM_CLAUDE_BIN?.trim()) return overrideBin(env.CONSORTIUM_CLAUDE_BIN);
  return findInDirs("claude", env);
}

export function findCodexBin(env: Env = process.env, paths: ToolPaths = {}): string | null {
  if (paths.codex?.trim()) return overrideBin(paths.codex);
  if (env.CONSORTIUM_CODEX_BIN?.trim()) return overrideBin(env.CONSORTIUM_CODEX_BIN);
  const home = os.homedir();
  const appBins = [...CODEX_APP_BINS, ...CODEX_APP_BINS.map((bin) => path.join(home, bin))];
  return findInDirs("codex", env) ?? appBins.find(isExecutableFile) ?? null;
}

// ---------- Default models ----------

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// One string setting from Claude Code's settings.json, or null.
function claudeSetting(env: Env, key: string): string | null {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  const text = readText(path.join(dir, "settings.json"));
  if (!text) return null;
  try {
    const value = (JSON.parse(text) as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

// ANTHROPIC_MODEL wins over the settings file, as it does in Claude Code.
export function claudeConfiguredModel(env: Env = process.env): string | null {
  if (env.ANTHROPIC_MODEL?.trim()) return env.ANTHROPIC_MODEL.trim();
  return claudeSetting(env, "model");
}

// CLAUDE_CODE_EFFORT_LEVEL wins over effortLevel in the settings file, as it
// does in Claude Code. Its values "auto" and "unset" leave the model's own
// default in place, which is not known here.
export function claudeConfiguredEffort(env: Env = process.env): string | null {
  const fromEnv = env.CLAUDE_CODE_EFFORT_LEVEL?.trim().toLowerCase();
  if (fromEnv) return fromEnv === "auto" || fromEnv === "unset" || !isThinkingLevel(fromEnv) ? null : fromEnv;
  const fromSettings = claudeSetting(env, "effortLevel")?.toLowerCase();
  return isThinkingLevel(fromSettings) ? fromSettings : null;
}

function codexHome(env: Env): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

export function codexConfigPath(env: Env = process.env): string {
  return path.join(codexHome(env), "config.toml");
}

// Reads `key = "..."` from the top of config.toml, before the first table.
function topLevelTomlString(toml: string, key: string): string | null {
  const pattern = new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) break;
    const match = pattern.exec(line);
    if (match) return (match[1] ?? match[2]).trim() || null;
  }
  return null;
}

export function codexModelFromToml(toml: string): string | null {
  return topLevelTomlString(toml, "model");
}

// The thinking level Codex uses when none is chosen: model_reasoning_effort.
export function codexEffortFromToml(toml: string): string | null {
  const effort = topLevelTomlString(toml, "model_reasoning_effort")?.toLowerCase();
  return isThinkingLevel(effort) ? effort : null;
}

// Codex keeps the models its account offers in models_cache.json, each with
// its thinking levels and default level. Returns the levels by model id, or
// an empty record when the text cannot be read.
export function codexModelThinking(json: string): Record<string, ThinkingInfo> {
  let models: unknown;
  try {
    models = (JSON.parse(json) as { models?: unknown }).models;
  } catch {
    return {};
  }
  const out: Record<string, ThinkingInfo> = {};
  if (!Array.isArray(models)) return out;
  for (const model of models as Array<Record<string, unknown> | null>) {
    const slug = model?.slug;
    if (!isToolModelId(slug) || !Array.isArray(model?.supported_reasoning_levels)) continue;
    const levels: string[] = [];
    for (const entry of model.supported_reasoning_levels as Array<{ effort?: unknown } | null>) {
      const effort = entry?.effort;
      if (isThinkingLevel(effort) && !levels.includes(effort)) levels.push(effort);
    }
    if (levels.length === 0) continue;
    const fallback = model.default_reasoning_level;
    out[slug] = { thinkingLevels: levels, ...(isThinkingLevel(fallback) ? { defaultThinking: fallback } : {}) };
  }
  return out;
}

export function readCodexModelThinking(env: Env = process.env): Record<string, ThinkingInfo> {
  const text = readText(path.join(codexHome(env), "models_cache.json"));
  return text ? codexModelThinking(text) : {};
}

// The names of the MCP servers in config.toml, so a call can turn them off.
export function codexMcpServerNames(toml: string): string[] {
  const names = new Set<string>();
  for (const raw of toml.split("\n")) {
    const match = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/.exec(raw);
    if (match) names.add(match[1] ?? match[2] ?? match[3]);
  }
  return [...names];
}

export function readCodexConfig(env: Env = process.env): string {
  return readText(codexConfigPath(env)) ?? "";
}

// "claude-sonnet-4-5-20250929" becomes "Sonnet 4.5", "claude-3-5-haiku"
// becomes "Haiku 3.5", "opus" becomes "Opus", and "sonnet[1m]" becomes
// "Sonnet (1M)". Names it cannot read are shown as they are.
export function formatClaudeModel(raw: string | null | undefined): string {
  const name = raw?.trim();
  if (!name || name === "default") return DEFAULT_MODEL_LABEL;
  let rest = name.toLowerCase();
  const longContext = /\[1m\]$/.test(rest);
  rest = rest.replace(/\[[^\]]*\]$/, "");
  rest = rest.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "");
  rest = rest.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/@\d{8}$/, "");
  const parts = rest.split("-").filter(Boolean);
  const words = parts.filter((p) => /^[a-z]+$/.test(p));
  const numbers = parts.filter((p) => /^\d+(?:\.\d+)*$/.test(p));
  if (words.length === 0 || words.length + numbers.length !== parts.length) return name;
  const label = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const version = numbers.join(".");
  return `${label}${version ? ` ${version}` : ""}${longContext ? " (1M)" : ""}`;
}

// ---------- Models seen in real calls ----------

// Claude Code names its model in the first line of every call. A call
// records it here, so the list shows the model actually in use from then on.
const seenModels = new Map<CliToolId, string>();

export function rememberModel(id: CliToolId, model: string): void {
  if (model.trim()) seenModels.set(id, model.trim());
}

export function forgetSeenModels(): void {
  seenModels.clear();
}

// ---------- Detection ----------

export type CliToolDetector = () => CliTool[];

export function detectCliTools(env: Env = process.env, paths: ToolPaths = {}): CliTool[] {
  const tools: CliTool[] = [];
  const claude = findClaudeBin(env, paths);
  if (claude) {
    tools.push({
      id: CLAUDE_CODE_ID,
      bin: claude,
      configuredModel: claudeConfiguredModel(env),
      configuredThinking: claudeConfiguredEffort(env),
    });
  }
  const codex = findCodexBin(env, paths);
  if (codex) {
    const toml = readCodexConfig(env);
    tools.push({
      id: CODEX_ID,
      bin: codex,
      configuredModel: codexModelFromToml(toml),
      configuredThinking: codexEffortFromToml(toml),
      modelThinking: readCodexModelThinking(env),
    });
  }
  return tools;
}

// Tests replace the detector so the list does not depend on this machine.
const defaultDetector: CliToolDetector = () => detectCliTools(process.env, readSettingsFile().toolPaths);
let detector: CliToolDetector = defaultDetector;

export function setCliToolDetector(next: CliToolDetector | null): void {
  detector = next ?? defaultDetector;
  toolCache = null;
}

const CACHE_MS = 10 * 60 * 1000;
let toolCache: { at: number; tools: CliTool[] } | null = null;

export function getCliTools(now: number = Date.now()): CliTool[] {
  if (toolCache && now - toolCache.at < CACHE_MS) return toolCache.tools;
  let tools: CliTool[] = [];
  try {
    tools = detector();
  } catch (err) {
    console.warn("Looking for Claude Code and Codex failed.", err);
  }
  toolCache = { at: now, tools };
  return tools;
}

export function clearCliToolCache(): void {
  toolCache = null;
}

export function findCliTool(id: string, now?: number): CliTool | null {
  return getCliTools(now).find((tool) => tool.id === id) ?? null;
}

// openaiModels: the OpenAI models Codex can run with, from the gateway list,
// with ids as Codex takes them.
export function cliModelInfo(tool: CliTool, openaiModels: ToolModel[] = CODEX_TOOL_MODELS): ModelInfo {
  const configured = isThinkingLevel(tool.configuredThinking) ? tool.configuredThinking : undefined;
  if (tool.id === CLAUDE_CODE_ID) {
    const model = seenModels.get(CLAUDE_CODE_ID) ?? tool.configuredModel;
    // Every alias takes the same levels, so they are given once, on the tool.
    return {
      id: CLAUDE_CODE_ID,
      name: "Claude Code",
      maker: "anthropic",
      defaultModel: formatClaudeModel(model),
      toolModels: CLAUDE_TOOL_MODELS.map((m) => ({ ...m })),
      thinkingLevels: [...CLAUDE_THINKING_LEVELS],
      ...(configured ? { defaultThinking: configured } : {}),
    };
  }
  const model = seenModels.get(CODEX_ID) ?? tool.configuredModel;
  // model_reasoning_effort in config.toml applies to every model. Without it,
  // each model starts on its own default level.
  const thinkingOf = (id: string | null): ThinkingInfo => {
    const cached = id ? tool.modelThinking?.[id] : undefined;
    const levels = cached?.thinkingLevels?.length ? cached.thinkingLevels : CODEX_THINKING_LEVELS;
    const fallback = configured ?? cached?.defaultThinking;
    return { thinkingLevels: [...levels], ...(fallback ? { defaultThinking: fallback } : {}) };
  };
  return {
    id: CODEX_ID,
    name: "Codex",
    maker: "openai",
    defaultModel: model || DEFAULT_MODEL_LABEL,
    toolModels: codexToolModels(openaiModels, tool.configuredModel).map((m) => ({ ...m, ...thinkingOf(m.id) })),
    ...thinkingOf(model),
  };
}

// Claude Code first, then Codex.
export function cliModelInfos(tools: CliTool[], openaiModels: ToolModel[] = CODEX_TOOL_MODELS): ModelInfo[] {
  const order: CliToolId[] = [CLAUDE_CODE_ID, CODEX_ID];
  return [...tools]
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    .map((tool) => cliModelInfo(tool, openaiModels));
}
