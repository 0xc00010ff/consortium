import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliTool } from "./cliTools";
import {
  buildModelsResponse,
  clearModelsCache,
  curate,
  familyOf,
  fetchPublicModelList,
  getModelsResponse,
  MOCK_MODELS,
  mockModelsResponse,
  pickDefaults,
} from "./models";
import { resolveKeys, writeSettingsFile } from "./settings";
import { isolateSettings, removeSettingsDirs } from "./settingsHome.testkit";

// The gateway list is replaced, so the test with a gateway key never reaches the network.
vi.mock("./gatewayClient", () => ({
  gatewayProvider: () => ({
    getAvailableModels: async () => ({
      models: [{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", modelType: "language" }],
    }),
  }),
}));

const lang = (id: string, name: string, released?: number) => ({ id, name, modelType: "language", released });

describe("model families", () => {
  it("removes version numbers from ids", () => {
    expect(familyOf("anthropic/claude-opus-5.5")).toBe("anthropic/claude-opus");
    expect(familyOf("openai/gpt-6.1-sol")).toBe("openai/gpt-sol");
    expect(familyOf("google/gemini-3.1-pro-preview")).toBe("google/gemini-pro-preview");
    expect(familyOf("google/gemini-3.5-flash-lite")).toBe("google/gemini-flash-lite");
    expect(familyOf("spacexai/grok-4.1-fast-reasoning")).toBe("spacexai/grok-fast-reasoning");
    expect(familyOf("spacexai/grok-4.7")).toBe("spacexai/grok");
  });
});

describe("the short list", () => {
  it("keeps the newest model of each family, in tier order, from a long list", () => {
    const response = buildModelsResponse([
      lang("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5"),
      lang("anthropic/claude-haiku-4.5", "Claude Haiku 4.5"),
      lang("anthropic/claude-haiku-5.5", "Claude Haiku 5.5"),
      lang("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"),
      lang("anthropic/claude-opus-5", "Claude Opus 5"),
      lang("anthropic/claude-opus-5.5", "Claude Opus 5.5"),
      lang("anthropic/claude-fable-5", "Claude Fable 5"),
      lang("anthropic/claude-fable-5.1", "Claude Fable 5.1"),
      lang("anthropic/claude-opus-5.5-batch", "Claude Opus 5.5 (Batch)"),
      lang("openai/gpt-5.5", "GPT 5.5"),
      lang("openai/gpt-5.5-pro", "GPT 5.5 Pro"),
      lang("openai/gpt-6-sol", "GPT-6 Sol"),
      lang("openai/gpt-6.1-sol", "GPT-6.1 Sol"),
      lang("openai/gpt-6-luna", "GPT-6 Luna"),
      lang("openai/gpt-6-astra", "GPT-6 Astra"),
      lang("openai/o3", "o3"),
      lang("openai/text-embedding-3-small", "Embedding").modelType === "language"
        ? { id: "openai/text-embedding-3-small", name: "Embedding", modelType: "embedding" }
        : lang("x", "x"),
      lang("google/gemini-2.5-pro", "Gemini 2.5 Pro"),
      lang("google/gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
      lang("google/gemini-3.5-flash", "Gemini 3.5 Flash"),
      lang("google/gemini-3.8-flash", "Gemini 3.8 Flash"),
      lang("google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"),
      lang("google/gemini-2.5-flash-image", "Nano Banana (Gemini 2.5 Flash Image)"),
      lang("spacexai/grok-4.5", "Grok 4.5"),
      lang("spacexai/grok-4.7", "Grok 4.7"),
      lang("spacexai/grok-4.1-fast-reasoning", "Grok 4.1 Fast Reasoning"),
      lang("spacexai/grok-4.20-reasoning", "Grok 4.20 Reasoning"),
      lang("mistral/mistral-large", "Mistral Large"),
    ]);
    expect(response.mock).toBe(false);
    expect(response.models.map((m) => m.id)).toEqual([
      "anthropic/claude-fable-5.1",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-haiku-5.5",
      "openai/gpt-6-astra",
      "openai/gpt-6.1-sol",
      "openai/gpt-6-luna",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.8-flash",
      "google/gemini-3.5-flash-lite",
      "spacexai/grok-4.7",
      "spacexai/grok-4.1-fast-reasoning",
    ]);
    expect(response.models.find((m) => m.id === "spacexai/grok-4.7")?.maker).toBe("xai");
    expect(response.defaults).toEqual({
      seats: ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol", "google/gemini-3.1-pro-preview", "spacexai/grok-4.7"],
      arbiter: "anthropic/claude-opus-5.5",
    });
  });

  it("prefers the release date over the version number when both are known", () => {
    const response = buildModelsResponse([
      lang("google/gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", 1_800_000_000),
      lang("google/gemini-4-pro", "Gemini 4 Pro", 1_700_000_000),
    ]);
    expect(response.models.map((m) => m.id)).toEqual(["google/gemini-3.1-pro-preview"]);
  });

  it("shows the newest few models of a maker whose names match no family", () => {
    const response = buildModelsResponse([
      lang("openai/o3", "o3"),
      lang("openai/gpt-5.5", "GPT 5.5"),
      lang("openai/gpt-5.4", "GPT 5.4"),
      lang("openai/gpt-5.2", "GPT 5.2"),
      lang("openai/gpt-5.5-pro", "GPT 5.5 Pro"),
      lang("google/gemini-3.5-flash", "Gemini 3.5 Flash"),
    ]);
    expect(response.models.map((m) => m.id)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.5-pro",
      "openai/gpt-5.4",
      "google/gemini-3.5-flash",
    ]);
    expect(response.defaults).toEqual({ seats: ["openai/gpt-5.5", "google/gemini-3.5-flash"], arbiter: "openai/gpt-5.5" });
  });

  it("leaves out image, batch and non-language models", () => {
    const response = buildModelsResponse([
      lang("google/gemini-2.5-flash-image", "Nano Banana (Gemini 2.5 Flash Image)"),
      lang("google/gemini-3-pro-image", "Nano Banana Pro (Gemini 3 Pro Image)"),
      lang("openai/gpt-image-1", "GPT Image 1"),
      lang("google/imagen-4.0-generate", "Imagen 4"),
      lang("anthropic/claude-opus-5.5-batch", "Claude Opus 5.5 (Batch)"),
      { id: "openai/text-embedding-3-small", name: "Embedding", modelType: "embedding" },
      lang("google/gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
    ]);
    expect(response.models.map((m) => m.id)).toEqual(["google/gemini-3.1-pro-preview"]);
  });

  it("gives the built-in sample list the same shape and defaults", () => {
    const response = buildModelsResponse(MOCK_MODELS.map((m) => lang(m.id, m.name)));
    expect(response.models).toEqual(MOCK_MODELS);
    expect(response.defaults).toEqual(pickDefaults(MOCK_MODELS));
    expect(curate(MOCK_MODELS).models).toEqual(MOCK_MODELS);
    expect(MOCK_MODELS).toHaveLength(12);
  });
});

describe("sample mode model list", () => {
  it("reads the public gateway list and keeps it marked as sample mode", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "anthropic/claude-fable-5.1", name: "Claude Fable 5.1", type: "language", released: 1_788_134_400 },
            { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", type: "language" },
            { id: "anthropic/claude-opus-5.5-batch", name: "Claude Opus 5.5 (Batch)", type: "language" },
            { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", type: "language" },
            { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", type: "language" },
            { id: "google/gemini-2.5-flash-image", name: "Nano Banana (Gemini 2.5 Flash Image)", type: "language" },
            { id: "openai/text-embedding-3-small", name: "Embedding", type: "embedding" },
            { id: "spacexai/grok-4.7", name: "Grok 4.7", type: "language" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    const entries = await fetchPublicModelList(fakeFetch);
    expect(entries.find((e) => e.id === "anthropic/claude-fable-5.1")?.released).toBe(1_788_134_400);
    const response = mockModelsResponse(entries);
    expect(response.mock).toBe(true);
    expect(response.models.map((m) => m.id)).toEqual([
      "anthropic/claude-fable-5.1",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4.5",
      "spacexai/grok-4.7",
    ]);
    expect(response.defaults.arbiter).toBe("anthropic/claude-opus-5.5");
  });

  it("falls back to the built-in list when the public list is empty or missing", () => {
    expect(mockModelsResponse([]).models).toEqual(MOCK_MODELS);
    expect(mockModelsResponse().models).toEqual(MOCK_MODELS);
    const ids = MOCK_MODELS.map((m) => m.id);
    expect(ids).toContain("anthropic/claude-fable-5.1");
    expect(ids).toContain("anthropic/claude-opus-5.5");
  });
});

describe("the first-run setup flag", () => {
  const saved = { ...process.env };
  const claude: CliTool = { id: "cli/claude-code", bin: "/x/claude", configuredModel: null };
  const noFile = { keys: {}, toolPaths: {}, setupDone: false };

  beforeEach(() => {
    isolateSettings();
    delete process.env.CONSORTIUM_MOCK;
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

  it("asks for setup with no key, no tools, and the setup not done", async () => {
    const body = await getModelsResponse({ tools: [] });
    expect(body.mock).toBe(true);
    expect(body.needsSetup).toBe(true);
  });

  it("still asks for setup when a tool is installed but no key is set", async () => {
    const body = await getModelsResponse({ tools: [claude], settings: noFile });
    expect(body.mock).toBe(false);
    expect(body.models.map((m) => m.id)).toEqual(["cli/claude-code"]);
    expect(body.needsSetup).toBe(true);
  });

  it("does not ask with a gateway key", async () => {
    process.env.AI_GATEWAY_API_KEY = "vck-test-not-used";
    const body = await getModelsResponse({ tools: [] });
    expect(body.mock).toBe(false);
    expect(body.needsSetup).toBeFalsy();
  });

  it("does not ask with a provider key from the settings file", async () => {
    writeSettingsFile({ keys: { openai: "sk-test-not-used" }, toolPaths: {}, setupDone: false });
    const body = await getModelsResponse({ tools: [] });
    expect(body.mock).toBe(false);
    expect(body.needsSetup).toBeFalsy();
  });

  it("does not ask once the setup is done, from the file or from the option", async () => {
    writeSettingsFile({ keys: {}, toolPaths: {}, setupDone: true });
    expect((await getModelsResponse({ tools: [] })).needsSetup).toBe(false);
    expect((await getModelsResponse({ tools: [claude] })).needsSetup).toBe(false);
    const done = { ...noFile, setupDone: true };
    expect((await getModelsResponse({ tools: [], settings: done, keys: resolveKeys(done, {}) })).needsSetup).toBe(false);
  });

  it("does not ask with CONSORTIUM_MOCK=1", async () => {
    process.env.CONSORTIUM_MOCK = "1";
    const body = await getModelsResponse({ tools: [], settings: noFile });
    expect(body.mock).toBe(true);
    expect(body.needsSetup).toBeFalsy();
  });
});
