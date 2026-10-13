import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliTool } from "./cliTools";
import { clearModelsCache, getModelsResponse, MOCK_MODELS } from "./models";
import { isolateSettings, removeSettingsDirs } from "./settingsHome.testkit";

// The gateway list is replaced, so the test with a key never reaches the network.
vi.mock("./gatewayClient", () => ({
  gatewayProvider: () => ({
    getAvailableModels: async () => ({
        models: [
          { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", modelType: "language" },
          { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", modelType: "language" },
          { id: "openai/gpt-7-sol", name: "GPT-7 Sol", modelType: "language" },
          { id: "openai/gpt-7-astra", name: "GPT-7 Astra", modelType: "language" },
        { id: "openai/gpt-5.5", name: "GPT 5.5", modelType: "language" },
      ],
    }),
  }),
}));

const saved = { ...process.env };
const claude: CliTool = { id: "cli/claude-code", bin: "/x/claude", configuredModel: "claude-sonnet-4-5-20250929" };
const codex: CliTool = { id: "cli/codex", bin: "/x/codex", configuredModel: "gpt-6-astra" };

const CLAUDE_ALIASES = [
  { id: "fable", name: "Fable" },
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
];
// The models Codex accepts, as the Codex command names them.
const BUILT_IN_CODEX = [
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-6-pro", name: "GPT-6 Pro" },
  { id: "gpt-6-sol", name: "GPT-6 Sol" },
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
  isolateSettings();
  clearModelsCache();
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});

afterEach(() => {
  process.env = { ...saved };
  removeSettingsDirs();
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
    // Codex keeps its own models whatever the gateway lists; the configured one is already there.
    expect(body.models[1].toolModels).toEqual(BUILT_IN_CODEX);
    expect(body.defaults).toEqual({ seats: ["cli/claude-code", "cli/codex"], arbiter: "cli/claude-code" });
  });

  it("with a key and only Codex, keeps the gateway arbiter", async () => {
    delete process.env.CONSORTIUM_MOCK;
    process.env.AI_GATEWAY_API_KEY = "test-key-not-used";
    const body = await getModelsResponse({ tools: [codex] });
    expect(body.defaults).toEqual({ seats: ["cli/codex"], arbiter: "anthropic/claude-sonnet-5.5" });
  });
});

describe("the model list with provider keys only", () => {
  const PUBLIC_LIST = {
    data: [
      { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", type: "language" },
      { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", type: "language" },
      { id: "openai/gpt-7-sol", name: "GPT-7 Sol", type: "language" },
      { id: "openai/gpt-7-astra", name: "GPT-7 Astra", type: "language" },
      { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", type: "language" },
      { id: "spacexai/grok-4.7", name: "Grok 4.7", type: "language" },
    ],
  };
  const anthropicOnly = {
    gateway: null,
    anthropic: { value: "sk-ant-test", source: "settings" as const },
    openai: null,
    google: null,
    xai: null,
  };

  beforeEach(() => {
    delete process.env.CONSORTIUM_MOCK;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(PUBLIC_LIST), { status: 200 }));
  });

  it("lists only the makers with a key, from the public list", async () => {
    const body = await getModelsResponse({ tools: [], keys: anthropicOnly });
    expect(body).toEqual({
      mock: false,
      models: [
        { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", maker: "anthropic" },
        { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", maker: "anthropic" },
      ],
      defaults: { seats: ["anthropic/claude-sonnet-5.5"], arbiter: "anthropic/claude-opus-5.5" },
    });
  });

  it("reads the keys from the settings file when none are passed", async () => {
    process.env.XAI_API_KEY = "xai-test-not-used";
    const body = await getModelsResponse({ tools: [] });
    expect(body.models.map((m) => m.id)).toEqual(["spacexai/grok-4.7"]);
    expect(body.defaults).toEqual({ seats: ["spacexai/grok-4.7"], arbiter: "spacexai/grok-4.7" });
  });

  it("keeps the tools first and as the default agents, and Codex its own models", async () => {
    const body = await getModelsResponse({ tools: [claude, codex], keys: anthropicOnly });
    expect(body.models.map((m) => m.id)).toEqual([
      "cli/claude-code",
      "cli/codex",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-sonnet-5.5",
    ]);
    expect(body.models[1].toolModels).toEqual(BUILT_IN_CODEX);
    expect(body.defaults).toEqual({ seats: ["cli/claude-code", "cli/codex"], arbiter: "cli/claude-code" });
  });

  it("falls back to the built-in list for those makers when the public list cannot be read", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in tests");
    });
    const body = await getModelsResponse({ tools: [], keys: anthropicOnly });
    expect(body.mock).toBe(false);
    expect(body.models).toEqual(MOCK_MODELS.filter((m) => m.maker === "anthropic"));
  });
});
