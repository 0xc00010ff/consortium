import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childEnv } from "./cli";
import { detectCliTools, type CliTool } from "./cliTools";
import { getToolStatuses, parseVersion, setVersionRunner } from "./toolStatus";

const claude: CliTool = { id: "cli/claude-code", bin: "/x/claude", configuredModel: "claude-opus-5-5" };
const codex: CliTool = { id: "cli/codex", bin: "/x/codex", configuredModel: "gpt-6-astra" };
const empty = { keys: {}, toolPaths: {} };

let runs: string[] = [];

beforeEach(() => {
  runs = [];
  setVersionRunner(async (bin) => {
    runs.push(bin);
    return bin.endsWith("claude") ? "2.1.290 (Claude Code)\n" : "codex-cli 0.46.0\n";
  });
});

afterEach(() => {
  setVersionRunner(null);
});

describe("tool status", () => {
  it("reports both tools, installed or not, with path, version and default model", async () => {
    const statuses = await getToolStatuses({ tools: [codex, claude], settings: empty, now: 1000 });
    expect(statuses).toEqual([
      { id: "cli/claude-code", name: "Claude Code", installed: true, path: "/x/claude", version: "2.1.290", defaultModel: "Opus 5.5" },
      { id: "cli/codex", name: "Codex", installed: true, path: "/x/codex", version: "0.46.0", defaultModel: "gpt-6-astra" },
    ]);

    const none = await getToolStatuses({ tools: [], settings: { keys: {}, toolPaths: { codex: "/opt/codex" } } });
    expect(none).toEqual([
      { id: "cli/claude-code", name: "Claude Code", installed: false },
      { id: "cli/codex", name: "Codex", installed: false, configuredPath: "/opt/codex" },
    ]);
  });

  it("keeps the version for 10 minutes", async () => {
    await getToolStatuses({ tools: [claude], settings: empty, now: 0 });
    await getToolStatuses({ tools: [claude], settings: empty, now: 9 * 60 * 1000 });
    expect(runs).toEqual(["/x/claude"]);
    await getToolStatuses({ tools: [claude], settings: empty, now: 11 * 60 * 1000 });
    expect(runs).toEqual(["/x/claude", "/x/claude"]);
  });

  it("leaves the version out when the command fails", async () => {
    setVersionRunner(async () => {
      throw new Error("exit 1");
    });
    const [status] = await getToolStatuses({ tools: [claude], settings: empty });
    expect(status.version).toBeUndefined();
    expect(status.installed).toBe(true);
  });

  it("reads the version number from the tool's output", () => {
    expect(parseVersion("2.1.290 (Claude Code)")).toBe("2.1.290");
    expect(parseVersion("codex-cli 0.46.0-alpha.2\n")).toBe("0.46.0-alpha.2");
    expect(parseVersion("dev build")).toBe("dev build");
    expect(parseVersion("\n")).toBeNull();
  });
});

describe("tool paths from the settings file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "consortium-tools-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function executable(name: string): string {
    const file = path.join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return file;
  }

  it("wins over the environment variable and the search", () => {
    const fromEnv = executable("claude-env");
    const fromSettings = executable("claude-settings");
    const env = { PATH: "", CONSORTIUM_CLAUDE_BIN: fromEnv, CONSORTIUM_CODEX_BIN: path.join(dir, "missing"), HOME: dir };
    expect(detectCliTools(env).map((t) => t.bin)).toEqual([fromEnv]);
    expect(detectCliTools(env, { claude: fromSettings }).map((t) => t.bin)).toEqual([fromSettings]);
  });

  it("reports a tool as missing when its saved path is not an executable", () => {
    const fromEnv = executable("claude-env");
    const env = { PATH: "", CONSORTIUM_CLAUDE_BIN: fromEnv, CONSORTIUM_CODEX_BIN: path.join(dir, "missing"), HOME: dir };
    expect(detectCliTools(env, { claude: path.join(dir, "nothing-here") })).toEqual([]);
  });
});

describe("the environment of tool commands", () => {
  it("leaves out every API key, so the tools run on their own sign-in", () => {
    const saved = { ...process.env };
    const names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"];
    try {
      for (const name of names) process.env[name] = "should-not-reach-the-tool";
      const env = childEnv();
      for (const name of names) expect(env[name]).toBeUndefined();
      expect(env.NO_COLOR).toBe("1");
    } finally {
      process.env = saved;
    }
  });
});
