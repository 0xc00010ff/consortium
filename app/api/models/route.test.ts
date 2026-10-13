import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsResponse } from "@/lib/types";
import { setCliToolDetector } from "@/lib/server/cliTools";
import { clearModelsCache, MOCK_MODELS } from "@/lib/server/models";
import { isolateSettings, removeSettingsDirs } from "@/lib/server/settingsHome.testkit";
import { GET } from "./route";

const saved = { ...process.env };

beforeEach(() => {
  isolateSettings();
  // Mock mode, so the tests never reach the gateway with a real key.
  process.env.CONSORTIUM_MOCK = "1";
  delete process.env.AI_GATEWAY_API_KEY;
  clearModelsCache();
  // The list must not depend on the tools installed on this machine.
  setCliToolDetector(() => []);
  // Keep the tests off the network: the public list fetch fails, so the
  // built-in sample list is used.
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});

afterEach(() => {
  process.env = { ...saved };
  removeSettingsDirs();
  vi.unstubAllGlobals();
  setCliToolDetector(null);
  clearModelsCache();
});

describe("GET /api/models in mock mode", () => {
  it("returns the built-in sample list and mock: true when no key is set and the public list is unreachable", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.CONSORTIUM_MOCK;
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ModelsResponse;
    expect(body.mock).toBe(true);
    expect(body.models).toEqual(MOCK_MODELS);
    expect(body.models.map((m) => m.id)).toContain("anthropic/claude-fable-5.1");
    expect(body.models.map((m) => m.id)).toContain("anthropic/claude-opus-5.5");
    expect(body.defaults.seats).toEqual([
      "anthropic/claude-sonnet-5.5",
      "openai/gpt-6.1-sol",
      "google/gemini-3.1-pro-preview",
      "spacexai/grok-4.7",
    ]);
    expect(body.defaults.arbiter).toBe("anthropic/claude-opus-5.5");
  });

  it("uses the public list when it can be fetched", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", type: "language" },
              { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", type: "language" },
              { id: "openai/gpt-5.5", name: "GPT 5.5", type: "language" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const body = (await (await GET()).json()) as ModelsResponse;
    expect(body.mock).toBe(true);
    expect(body.models.map((m) => m.id)).toEqual(["anthropic/claude-opus-5.5", "anthropic/claude-haiku-4.5", "openai/gpt-5.5"]);
  });

  it("stays in mock mode with CONSORTIUM_MOCK=1 even when a key is set", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key-not-used";
    process.env.CONSORTIUM_MOCK = "1";
    const body = (await (await GET()).json()) as ModelsResponse;
    expect(body.mock).toBe(true);
  });
});

describe("GET /api/models with Claude Code installed", () => {
  it("offers Claude Code alone, as a real model, when no key is set", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.CONSORTIUM_MOCK;
    setCliToolDetector(() => [{ id: "cli/claude-code", bin: "/x/claude", configuredModel: "opus" }]);
    const body = (await (await GET()).json()) as ModelsResponse;
    expect(body).toEqual({
      mock: false,
      models: [
        {
          id: "cli/claude-code",
          name: "Claude Code",
          maker: "anthropic",
          defaultModel: "Opus",
          toolModels: [{ id: "fable", name: "Fable" }, { id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }, { id: "haiku", name: "Haiku" }],
        },
      ],
      defaults: { seats: ["cli/claude-code"], arbiter: "cli/claude-code" },
    });
  });

  it("lists it first in mock mode, with the sample list after it", async () => {
    process.env.CONSORTIUM_MOCK = "1";
    setCliToolDetector(() => [{ id: "cli/claude-code", bin: "/x/claude", configuredModel: null }]);
    const body = (await (await GET()).json()) as ModelsResponse;
    expect(body.mock).toBe(true);
    expect(body.models[0]).toEqual({
      id: "cli/claude-code",
      name: "Claude Code",
      maker: "anthropic",
      defaultModel: "default model",
      toolModels: [{ id: "fable", name: "Fable" }, { id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }, { id: "haiku", name: "Haiku" }],
    });
    expect(body.models.slice(1)).toEqual(MOCK_MODELS);
    expect(body.defaults.arbiter).toBe("cli/claude-code");
  });
});
