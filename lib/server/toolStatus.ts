// What the server found about Claude Code and Codex, for the settings modal:
// whether each is installed, the command it runs, its version, and the model
// it uses by default. The version comes from `<tool> --version`, which sends
// nothing to a model, and is kept for 10 minutes.

import { execFile } from "node:child_process";
import type { ToolStatus } from "@/lib/types";
import { childEnv } from "./cli";
import { CLAUDE_CODE_ID, CODEX_ID, cliModelInfo, getCliTools, type CliTool, type CliToolId } from "./cliTools";
import { readSettingsFile, type SettingsFile } from "./settings";

const CACHE_MS = 10 * 60 * 1000;
const VERSION_TIMEOUT_MS = 5000;

export type VersionRunner = (bin: string) => Promise<string>;

// Runs `<bin> --version` without API keys in its environment, and returns
// what it printed.
const runVersion: VersionRunner = (bin) =>
  new Promise((resolve, reject) => {
    execFile(bin, ["--version"], { timeout: VERSION_TIMEOUT_MS, env: childEnv(), maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

let versionRunner: VersionRunner = runVersion;
const versionCache = new Map<string, { at: number; version: string | null }>();

// Tests replace the runner so no tool is started.
export function setVersionRunner(next: VersionRunner | null): void {
  versionRunner = next ?? runVersion;
  versionCache.clear();
}

export function clearToolVersionCache(): void {
  versionCache.clear();
}

// "2.1.290 (Claude Code)" becomes "2.1.290", and "codex-cli 0.46.0" becomes
// "0.46.0". Output without a version number is shown as its first line.
export function parseVersion(output: string): string | null {
  const first = output.split("\n").map((line) => line.trim()).find(Boolean);
  if (!first) return null;
  const match = /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?/.exec(first);
  return match ? match[0] : first.slice(0, 60);
}

export async function toolVersion(bin: string, now: number = Date.now()): Promise<string | null> {
  const cached = versionCache.get(bin);
  if (cached && now - cached.at < CACHE_MS) return cached.version;
  let version: string | null = null;
  try {
    version = parseVersion(await versionRunner(bin));
  } catch (err) {
    console.warn(`Reading the version of ${bin} failed.`, err);
  }
  versionCache.set(bin, { at: now, version });
  return version;
}

const TOOLS: Array<{ id: CliToolId; name: string; pathName: "claude" | "codex" }> = [
  { id: CLAUDE_CODE_ID, name: "Claude Code", pathName: "claude" },
  { id: CODEX_ID, name: "Codex", pathName: "codex" },
];

export interface ToolStatusOptions {
  now?: number;
  tools?: CliTool[]; // the installed tools; detected when absent
  settings?: SettingsFile; // read from the settings file when absent
}

// Claude Code first, then Codex, installed or not.
export async function getToolStatuses({ now = Date.now(), tools, settings }: ToolStatusOptions = {}): Promise<ToolStatus[]> {
  const found = tools ?? getCliTools(now);
  const paths = (settings ?? readSettingsFile()).toolPaths;
  return Promise.all(
    TOOLS.map(async ({ id, name, pathName }): Promise<ToolStatus> => {
      const tool = found.find((t) => t.id === id);
      const status: ToolStatus = { id, name, installed: Boolean(tool) };
      if (tool) {
        status.path = tool.bin;
        const version = await toolVersion(tool.bin, now);
        if (version) status.version = version;
        const defaultModel = cliModelInfo(tool).defaultModel;
        if (defaultModel) status.defaultModel = defaultModel;
      }
      const configured = paths[pathName];
      if (configured) status.configuredPath = configured;
      return status;
    }),
  );
}
