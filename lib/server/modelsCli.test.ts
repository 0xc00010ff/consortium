import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliTool } from "./cliTools";
import { clearModelsCache, codexChoices, getModelsResponse, MOCK_MODELS } from "./models";

// The gateway list is replaced, so the test with a key never reaches the network.
vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return {
    ...original,
    gateway: {
      ...original.gateway,
      getAvailableModels: async () => ({
        models: [
          { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", modelType: "language" },
          { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", modelType: "language" },
          { id: "openai/gpt-7-sol", name: "GPT-7 Sol", modelType: "language" },
          { id: "openai/gpt-7-astra", name: "GPT-7 Astra", modelType: "language" },
          { id: "openai/gpt-5.5", name: "GPT 5.5", modelType: "language" },
        ],
      }),
    },
  };
});

const saved = { ...process.env };
const claude: CliTool = { id: "cli/claude-code", bin: "/x/claude", configuredModel: "claude-sonnet-4-5-20250929" };
const codex: CliTool = { id: "cli/codex", bin: "/x/codex", configuredModel: "gpt-6-astra" };

const CLAUDE_ALIASES = [
  { id: "fable", name: "Fable" },
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
];
// The OpenAI models of the built-in list, used when no gateway list can be read.
const BUILT_IN_CODEX = [
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
];
const claudeInfo = {
  id: "cli/claude-code",
  name: "Claude Code",
  maker: "anthropic",
  defaultModel: "Sonnet 4.5",
  toolModels: CLAUDE_ALIASES,
};
const codexInfo = { id: "cli/codex", name: "Codex", maker: "openai", defaultModel: "gpt-6-astra", toolModels: BUILT_IN_CODEX };

beforeEach(() => {
  clearModelsCache();
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});

afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  clearModelsCache();
});

describe("the model list with Claude Code and Codex", () => {
  it("in sample mode, puts the installed tools first and makes them the default agents", async () => {
    process.env.CONSORTIUM_MOCK = "1";
    const body = await getModelsResponse({ tools: [codex, claude] });
    expect(body.mock).toBe(true);
    expect(body.models.slice(0, 2)).toEqual([claudeInfo, codexInfo]);
    expect(body.models.slice(2)).toEqual(MOCK_MODELS);
    expect(body.defaults.seats).toEqual(["cli/claude-code", "cli/codex"]);
    expect(body.defaults.arbiter).toBe("cli/claude-code");
  });

  it("in sample mode without Claude Code, keeps the gateway arbiter", async () => {
    process.env.CONSORTIUM_MOCK = "1";
    const body = await getModelsResponse({ tools: [codex] });
    expect(body.defaults).toEqual({ seats: ["cli/codex"], arbiter: "anthropic/claude-opus-5.5" });
  });

  it("without a key, offers only the installed tools and seats them by default", async () => {
    delete process.env.CONSORTIUM_MOCK;
    delete process.env.AI_GATEWAY_API_KEY;
    const both = await getModelsResponse({ tools: [claude, codex] });
    expect(both).toEqual({
      mock: false,
      models: [claudeInfo, codexInfo],
      defaults: { seats: ["cli/claude-code", "cli/codex"], arbiter: "cli/claude-code" },
    });
    const codexOnly = await getModelsResponse({ tools: [{ ...codex, configuredModel: "gpt-5.5-codex" }] });
    expect(codexOnly.models).toEqual([
      { ...codexInfo, defaultModel: "gpt-5.5-codex", toolModels: [...BUILT_IN_CODEX, { id: "gpt-5.5-codex", name: "gpt-5.5-codex" }] },
    ]);
    expect(codexOnly.defaults).toEqual({ seats: ["cli/codex"], arbiter: "cli/codex" });
  });

  it("without a key or a tool, stays in sample mode", async () => {
    delete process.env.CONSORTIUM_MOCK;
    delete process.env.AI_GATEWAY_API_KEY;
    const body = await getModelsResponse({ tools: [] });
    expect(body.mock).toBe(true);
    expect(body.models).toEqual(MOCK_MODELS);
  });

  it("with a key, adds the tools in front of the gateway models and makes them the default agents", async () => {
    delete process.env.CONSORTIUM_MOCK;
    process.env.AI_GATEWAY_API_KEY = "test-key-not-used";
    const body = await getModelsResponse({ tools: [claude, codex] });
    expect(body.mock).toBe(false);
    expect(body.models.map((m) => m.id)).toEqual([
      "cli/claude-code",
      "cli/codex",
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-haiku-5.5",
      "openai/gpt-7-astra",
      "openai/gpt-7-sol",
    ]);
    expect(body.models[0]).toEqual(claudeInfo);
    // Codex gets the gateway's OpenAI models, then its configured model once.
    expect(body.models[1].toolModels).toEqual([
      { id: "gpt-7-astra", name: "GPT-7 Astra" },
      { id: "gpt-7-sol", name: "GPT-7 Sol" },
      { id: "gpt-6-astra", name: "gpt-6-astra" },
    ]);
    expect(body.defaults).toEqual({ seats: ["cli/claude-code", "cli/codex"], arbiter: "cli/claude-code" });
  });

  it("with a key and only Codex, keeps the gateway arbiter", async () => {
    delete process.env.CONSORTIUM_MOCK;
    process.env.AI_GATEWAY_API_KEY = "test-key-not-used";
    const body = await getModelsResponse({ tools: [codex] });
    expect(body.defaults).toEqual({ seats: ["cli/codex"], arbiter: "anthropic/claude-sonnet-5.5" });
  });
});

describe("the Codex model choices", () => {
  it("takes the curated OpenAI families from a list, newest tier first, without the prefix", () => {
    expect(
      codexChoices([
        { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", maker: "anthropic" },
        { id: "openai/gpt-7-astra", name: "GPT-7 Astra", maker: "openai" },
        { id: "openai/gpt-7-luna", name: "GPT-7 Luna", maker: "openai" },
        { id: "openai/gpt-5.5", name: "GPT 5.5", maker: "openai" },
      ]),
    ).toEqual([
      { id: "gpt-7-astra", name: "GPT-7 Astra" },
      { id: "gpt-7-luna", name: "GPT-7 Luna" },
    ]);
  });

  it("falls back to the built-in OpenAI models when the list has none", () => {
    expect(codexChoices([])).toEqual(BUILT_IN_CODEX);
    expect(codexChoices(MOCK_MODELS)).toEqual(BUILT_IN_CODEX);
  });
});
