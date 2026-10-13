import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_TOOL_MODELS,
  claudeConfiguredModel,
  cliModelInfos,
  codexToolModels,
  codexMcpServerNames,
  codexModelFromToml,
  detectCliTools,
  findClaudeBin,
  formatClaudeModel,
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
      { id: "cli/claude-code", bin: claude, configuredModel: null },
      { id: "cli/codex", bin: codex, configuredModel: "gpt-6-astra" },
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
    });
    info.toolModels?.push({ id: "x", name: "x" });
    expect(CLAUDE_TOOL_MODELS).toHaveLength(4);
  });

  it("offers Codex the given OpenAI models, adding the configured model once at the end", () => {
    expect(cliModelInfos([codex], openai)[0]).toEqual({
      id: "cli/codex",
      name: "Codex",
      maker: "openai",
      defaultModel: "gpt-6-astra",
      toolModels: openai,
    });
    expect(codexToolModels(openai, "gpt-5.5-codex")).toEqual([...openai, { id: "gpt-5.5-codex", name: "gpt-5.5-codex" }]);
    expect(codexToolModels([], null)).toEqual([]);
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
