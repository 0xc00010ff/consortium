import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_THINKING_LEVELS,
  CLAUDE_TOOL_MODELS,
  claudeConfiguredEffort,
  claudeConfiguredModel,
  cliModelInfos,
  CODEX_THINKING_LEVELS,
  codexEffortFromToml,
  codexToolModels,
  codexMcpServerNames,
  codexModelFromToml,
  codexModelThinking,
  detectCliTools,
  findClaudeBin,
  formatClaudeModel,
  isThinkingLevel,
  isToolModelId,
} from "./cliTools";

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "consortium-detect-"));
}

function executable(dir: string, name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

describe("default model names", () => {
  it("formats Claude model ids and aliases for people", () => {
    expect(formatClaudeModel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(formatClaudeModel("claude-opus-4-1")).toBe("Opus 4.1");
    expect(formatClaudeModel("claude-3-5-haiku-20241022")).toBe("Haiku 3.5");
    expect(formatClaudeModel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(formatClaudeModel("claude-sonnet-5.5")).toBe("Sonnet 5.5");
    expect(formatClaudeModel("sonnet")).toBe("Sonnet");
    expect(formatClaudeModel("opus[1m]")).toBe("Opus (1M)");
    expect(formatClaudeModel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("Sonnet 4.5");
    expect(formatClaudeModel("default")).toBe("default model");
    expect(formatClaudeModel(null)).toBe("default model");
    expect(formatClaudeModel("my_custom/model")).toBe("my_custom/model");
  });

  it("reads the top-level model from Codex's config.toml", () => {
    expect(codexModelFromToml('# comment\nmodel = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n')).toBe("gpt-6-astra");
    expect(codexModelFromToml('[profiles.fast]\nmodel = "gpt-6-luna"\n')).toBeNull();
    expect(codexModelFromToml("")).toBeNull();
  });

  it("lists the MCP servers in Codex's config.toml once each", () => {
    const toml = '[mcp_servers.a]\ncommand = "x"\n[mcp_servers.a.env]\n[mcp_servers."b c"]\n[projects."/x"]\n';
    expect(codexMcpServerNames(toml)).toEqual(["a", "b c"]);
  });

  it("reads Claude Code's model from ANTHROPIC_MODEL, then settings.json", () => {
    const dir = tempDir();
    expect(claudeConfiguredModel({ CLAUDE_CONFIG_DIR: dir })).toBeNull();
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "opus" }));
    expect(claudeConfiguredModel({ CLAUDE_CONFIG_DIR: dir })).toBe("opus");
    expect(claudeConfiguredModel({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_MODEL: "sonnet" })).toBe("sonnet");
  });
});

describe("default thinking levels", () => {
  it("reads Claude Code's level from CLAUDE_CODE_EFFORT_LEVEL, then effortLevel in settings.json", () => {
    const dir = tempDir();
    expect(claudeConfiguredEffort({ CLAUDE_CONFIG_DIR: dir })).toBeNull();
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "opus", effortLevel: "xhigh" }));
    expect(claudeConfiguredEffort({ CLAUDE_CONFIG_DIR: dir })).toBe("xhigh");
    expect(claudeConfiguredEffort({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_EFFORT_LEVEL: "Low" })).toBe("low");
    // "auto" and "unset" leave the model's own default, which is not known here.
    expect(claudeConfiguredEffort({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_EFFORT_LEVEL: "auto" })).toBeNull();
    expect(claudeConfiguredEffort({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_EFFORT_LEVEL: "unset" })).toBeNull();
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ effortLevel: "very much" }));
    expect(claudeConfiguredEffort({ CLAUDE_CONFIG_DIR: dir })).toBeNull();
  });

  it("reads Codex's level from model_reasoning_effort at the top of config.toml", () => {
    expect(codexEffortFromToml('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n')).toBe("low");
    expect(codexEffortFromToml("model_reasoning_effort = 'XHigh'\n")).toBe("xhigh");
    expect(codexEffortFromToml('[profiles.deep]\nmodel_reasoning_effort = "max"\n')).toBeNull();
    expect(codexEffortFromToml('model = "gpt-6.1-sol"\n')).toBeNull();
    // The model setting is not confused with the longer key.
    expect(codexModelFromToml('model_reasoning_effort = "low"\nmodel = "gpt-6-luna"\n')).toBe("gpt-6-luna");
  });

  it("reads each model's levels and default from Codex's models_cache.json", () => {
    const cache = {
      fetched_at: "2026-11-18T00:00:00Z",
      models: [
        {
          slug: "gpt-6.1-sol",
          visibility: "list",
          default_reasoning_level: "low",
          supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort, description: "..." })),
        },
        {
          slug: "gpt-6-luna",
          visibility: "list",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "max" }, { effort: "max" }, { effort: "-x" }],
        },
        { slug: "no-levels", supported_reasoning_levels: [] },
        { slug: "--bad", supported_reasoning_levels: [{ effort: "low" }] },
        null,
      ],
    };
    expect(codexModelThinking(JSON.stringify(cache))).toEqual({
      "gpt-6.1-sol": { thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultThinking: "low" },
      "gpt-6-luna": { thinkingLevels: ["low", "medium", "max"], defaultThinking: "medium" },
    });
    expect(codexModelThinking("not json")).toEqual({});
    expect(codexModelThinking("{}")).toEqual({});
  });

  it("accepts only short lowercase words as levels", () => {
    for (const ok of ["low", "xhigh", "max", "ultra", "none", "budget_tokens"]) expect(isThinkingLevel(ok)).toBe(true);
    for (const bad of ["", "High", "-low", "x y", 'a"', "1low", "x".repeat(17), 5, null, undefined]) {
      expect(isThinkingLevel(bad)).toBe(false);
    }
  });
});

describe("finding the tools", () => {
  it("finds claude on the PATH", () => {
    const dir = tempDir();
    const bin = executable(dir, "claude");
    expect(findClaudeBin({ PATH: dir })).toBe(bin);
  });

  it("uses the *_BIN variables when set, and finds nothing when they point nowhere", () => {
    const dir = tempDir();
    const claude = executable(dir, "my-claude");
    const codexDir = tempDir();
    writeFileSync(path.join(codexDir, "config.toml"), 'model = "gpt-6-astra"\n');
    const codex = executable(dir, "my-codex");
    const env = { PATH: "", CONSORTIUM_CLAUDE_BIN: claude, CONSORTIUM_CODEX_BIN: codex, CODEX_HOME: codexDir, CLAUDE_CONFIG_DIR: tempDir() };
    expect(detectCliTools(env)).toEqual([
      { id: "cli/claude-code", bin: claude, configuredModel: null, configuredThinking: null },
      { id: "cli/codex", bin: codex, configuredModel: "gpt-6-astra", configuredThinking: null, modelThinking: {} },
    ]);
    expect(detectCliTools({ PATH: "", CONSORTIUM_CLAUDE_BIN: "/nonexistent/claude", CONSORTIUM_CODEX_BIN: "/nonexistent/codex" })).toEqual([]);
  });
});

describe("tool model choices", () => {
  const claude = { id: "cli/claude-code" as const, bin: "/x/claude", configuredModel: "opus" };
  const codex = { id: "cli/codex" as const, bin: "/x/codex", configuredModel: "gpt-6-astra" };
  const openai = [
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
  ];

  it("offers Claude Code its model aliases and keeps the other fields", () => {
    const [info] = cliModelInfos([claude]);
    expect(info).toEqual({
      id: "cli/claude-code",
      name: "Claude Code",
      maker: "anthropic",
      defaultModel: "Opus",
      toolModels: [
        { id: "fable", name: "Fable" },
        { id: "opus", name: "Opus" },
        { id: "sonnet", name: "Sonnet" },
        { id: "haiku", name: "Haiku" },
      ],
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    info.toolModels?.push({ id: "x", name: "x" });
    info.thinkingLevels?.push("x");
    expect(CLAUDE_TOOL_MODELS).toHaveLength(4);
    expect(CLAUDE_THINKING_LEVELS).toHaveLength(5);
  });

  it("gives Claude Code's levels once for every alias, with the configured default", () => {
    const [info] = cliModelInfos([{ ...claude, configuredThinking: "xhigh" }]);
    expect(info.thinkingLevels).toEqual(CLAUDE_THINKING_LEVELS);
    expect(info.defaultThinking).toBe("xhigh");
    expect(info.toolModels?.every((m) => m.thinkingLevels === undefined)).toBe(true);
  });

  it("offers Codex the given OpenAI models, adding the configured model once at the end", () => {
    const levels = { thinkingLevels: CODEX_THINKING_LEVELS };
    expect(cliModelInfos([codex], openai)[0]).toEqual({
      id: "cli/codex",
      name: "Codex",
      maker: "openai",
      defaultModel: "gpt-6-astra",
      toolModels: openai.map((m) => ({ ...m, ...levels })),
      ...levels,
    });
    expect(codexToolModels(openai, "gpt-5.5-codex")).toEqual([...openai, { id: "gpt-5.5-codex", name: "gpt-5.5-codex" }]);
    expect(codexToolModels([], null)).toEqual([]);
  });

  it("gives each Codex model its levels from the cache, and the config.toml level as every model's default", () => {
    const modelThinking = {
      "gpt-6-astra": { thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultThinking: "medium" },
      "gpt-6-luna": { thinkingLevels: ["low", "medium", "high", "xhigh", "max"], defaultThinking: "medium" },
    };
    const [own] = cliModelInfos([{ ...codex, modelThinking }], openai);
    // The default model is gpt-6-astra, so the tool shows its levels.
    expect(own.thinkingLevels).toEqual(modelThinking["gpt-6-astra"].thinkingLevels);
    expect(own.defaultThinking).toBe("medium");
    expect(own.toolModels).toEqual([
      { id: "gpt-6-astra", name: "GPT-6 Astra", ...modelThinking["gpt-6-astra"] },
      // Not in the cache: the levels Codex models usually offer, with no known default.
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", thinkingLevels: CODEX_THINKING_LEVELS },
      { id: "gpt-6-luna", name: "GPT-6 Luna", ...modelThinking["gpt-6-luna"] },
    ]);

    const [configured] = cliModelInfos([{ ...codex, modelThinking, configuredThinking: "low" }], openai);
    expect(configured.defaultThinking).toBe("low");
    expect(configured.toolModels?.map((m) => m.defaultThinking)).toEqual(["low", "low", "low"]);
  });

  it("never lists an empty or unsafe id", () => {
    const list = codexToolModels([{ id: "", name: "Empty" }, { id: "-x", name: "Flag" }, openai[0], openai[0]], "my model");
    expect(list).toEqual([openai[0]]);
    expect(cliModelInfos([claude, codex], openai).flatMap((m) => m.toolModels ?? []).every((m) => m.id !== "")).toBe(true);
  });

  it("accepts only ids that are safe as one argument", () => {
    for (const ok of ["opus", "gpt-6.1-sol", "claude-sonnet-4-5-20250929", "us.anthropic.claude-sonnet-4-5-v1:0", "a"]) {
      expect(isToolModelId(ok)).toBe(true);
    }
    for (const bad of ["", "-m", "--model=x", "opus 4", 'a"b', "a'b", ".hidden", "a/b", "x".repeat(65), 7, null, undefined]) {
      expect(isToolModelId(bad)).toBe(false);
    }
  });
});
