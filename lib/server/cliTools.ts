// Finds the Claude Code and Codex command line tools on this machine, and
// the model each one uses by default. A tool that is found appears in the
// model list as "cli/claude-code" or "cli/codex". Calls to it run on the
// host's own subscription through lib/server/cli.ts.
//
// Detection only looks at files. It never starts either tool.

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelInfo, ToolModel } from "@/lib/types";

export const CLAUDE_CODE_ID = "cli/claude-code";
export const CODEX_ID = "cli/codex";
export type CliToolId = typeof CLAUDE_CODE_ID | typeof CODEX_ID;

// The environment to read: process.env, or a plain object in tests.
type Env = Record<string, string | undefined>;

export const DEFAULT_MODEL_LABEL = "default model";

export interface CliTool {
  id: CliToolId;
  bin: string; // absolute path of the command
  configuredModel: string | null; // from the tool's settings, before formatting
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

// ---------- Model choices ----------

// The aliases Claude Code accepts for --model. Each one runs the latest
// model of that tier.
export const CLAUDE_TOOL_MODELS: ToolModel[] = [
  { id: "fable", name: "Fable" },
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
];

// The models Codex can run with: the given OpenAI models, then the model from
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

export function findClaudeBin(env: Env = process.env): string | null {
  if (env.CONSORTIUM_CLAUDE_BIN?.trim()) return overrideBin(env.CONSORTIUM_CLAUDE_BIN);
  return findInDirs("claude", env);
}

export function findCodexBin(env: Env = process.env): string | null {
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

// ANTHROPIC_MODEL wins over the settings file, as it does in Claude Code.
export function claudeConfiguredModel(env: Env = process.env): string | null {
  if (env.ANTHROPIC_MODEL?.trim()) return env.ANTHROPIC_MODEL.trim();
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  const text = readText(path.join(dir, "settings.json"));
  if (!text) return null;
  try {
    const model = (JSON.parse(text) as { model?: unknown }).model;
    return typeof model === "string" && model.trim() ? model.trim() : null;
  } catch {
    return null;
  }
}

export function codexConfigPath(env: Env = process.env): string {
  const dir = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(dir, "config.toml");
}

// Reads `model = "..."` from the top of config.toml, before the first table.
export function codexModelFromToml(toml: string): string | null {
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) break;
    const match = /^model\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (match) return (match[1] ?? match[2]).trim() || null;
  }
  return null;
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

export function detectCliTools(env: Env = process.env): CliTool[] {
  const tools: CliTool[] = [];
  const claude = findClaudeBin(env);
  if (claude) tools.push({ id: CLAUDE_CODE_ID, bin: claude, configuredModel: claudeConfiguredModel(env) });
  const codex = findCodexBin(env);
  if (codex) tools.push({ id: CODEX_ID, bin: codex, configuredModel: codexModelFromToml(readCodexConfig(env)) });
  return tools;
}

// Tests replace the detector so the list does not depend on this machine.
let detector: CliToolDetector = () => detectCliTools();

export function setCliToolDetector(next: CliToolDetector | null): void {
  detector = next ?? (() => detectCliTools());
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
export function cliModelInfo(tool: CliTool, openaiModels: ToolModel[] = []): ModelInfo {
  if (tool.id === CLAUDE_CODE_ID) {
    const model = seenModels.get(CLAUDE_CODE_ID) ?? tool.configuredModel;
    return {
      id: CLAUDE_CODE_ID,
      name: "Claude Code",
      maker: "anthropic",
      defaultModel: formatClaudeModel(model),
      toolModels: CLAUDE_TOOL_MODELS.map((m) => ({ ...m })),
    };
  }
  const model = seenModels.get(CODEX_ID) ?? tool.configuredModel;
  return {
    id: CODEX_ID,
    name: "Codex",
    maker: "openai",
    defaultModel: model || DEFAULT_MODEL_LABEL,
    toolModels: codexToolModels(openaiModels, tool.configuredModel),
  };
}

// Claude Code first, then Codex.
export function cliModelInfos(tools: CliTool[], openaiModels: ToolModel[] = []): ModelInfo[] {
  const order: CliToolId[] = [CLAUDE_CODE_ID, CODEX_ID];
  return [...tools]
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    .map((tool) => cliModelInfo(tool, openaiModels));
}
