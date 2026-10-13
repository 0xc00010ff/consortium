import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { KeyName } from "@/lib/types";
import { streamSpeakEvents, withSearchNote } from "./gateway";
import { missingKeyMessage, providerModel, providerModelId, routeModel } from "./providers";
import type { ResolvedKeys } from "./settings";
import { browsingTools, NO_WEB_SEARCH_NOTE } from "./tools";

function keys(values: Partial<Record<KeyName, string>>): ResolvedKeys {
  const all: ResolvedKeys = { gateway: null, anthropic: null, openai: null, google: null, xai: null };
  for (const [name, value] of Object.entries(values)) all[name as KeyName] = { value: value as string, source: "settings" };
  return all;
}

describe("provider model ids", () => {
  it("maps gateway ids to each provider's own ids", () => {
    expect(providerModelId("anthropic/claude-sonnet-4.5")).toEqual({ maker: "anthropic", id: "claude-sonnet-4-5" });
    expect(providerModelId("anthropic/claude-opus-5.5")).toEqual({ maker: "anthropic", id: "claude-opus-5-5" });
    expect(providerModelId("anthropic/claude-fable-5.1")).toEqual({ maker: "anthropic", id: "claude-fable-5-1" });
    expect(providerModelId("openai/gpt-6.1-sol")).toEqual({ maker: "openai", id: "gpt-6.1-sol" });
    expect(providerModelId("google/gemini-3.1-pro-preview")).toEqual({ maker: "google", id: "gemini-3.1-pro-preview" });
    expect(providerModelId("xai/grok-4.7")).toEqual({ maker: "xai", id: "grok-4.7" });
    expect(providerModelId("spacexai/grok-4.20-reasoning")).toEqual({ maker: "xai", id: "grok-4.20-reasoning" });
    expect(providerModelId("spacexai/grok-4.1-fast-reasoning")).toEqual({ maker: "xai", id: "grok-4-1-fast-reasoning" });
    expect(providerModelId("meta/llama-5")).toBeNull();
  });
});

describe("provider models", () => {
  it("builds each provider's model with the mapped id, without making a call", () => {
    const cases = [
      ["anthropic", "claude-sonnet-5-5", "anthropic"],
      ["openai", "gpt-6.1-sol", "openai"],
      ["google", "gemini-3.8-flash", "google"],
      ["xai", "grok-4.7", "xai"],
    ] as const;
    for (const [maker, id, provider] of cases) {
      const model = providerModel(maker, id, "test-key-not-used") as { modelId: string; provider: string };
      expect(model.modelId).toBe(id);
      expect(model.provider.startsWith(provider)).toBe(true);
    }
  });
});

describe("choosing the route for a model", () => {
  const fakeMake = (maker: string, id: string, key: string) => `${maker}:${id}:${key}`;

  it("uses the gateway for everything when a gateway key is set", () => {
    const route = routeModel("openai/gpt-6.1-sol", keys({ gateway: "vck_1", openai: "sk-1" }), fakeMake as never);
    expect(route.kind).toBe("gateway");
    expect(route.kind === "gateway" && route.gatewayKey).toBe("vck_1");
  });

  it("uses the maker's own key without a gateway key", () => {
    const route = routeModel("anthropic/claude-sonnet-5.5", keys({ anthropic: "sk-ant" }), fakeMake as never);
    expect(route).toEqual({
      kind: "provider",
      model: "anthropic:claude-sonnet-5-5:sk-ant",
      maker: "anthropic",
      service: "Anthropic",
    });
  });

  it("explains a model whose maker has no key", () => {
    expect(routeModel("openai/gpt-6.1-sol", keys({ anthropic: "sk-ant" }))).toEqual({
      kind: "missing-key",
      message: "No key for OpenAI. Add a gateway key or an OpenAI key in Settings.",
    });
    expect(missingKeyMessage("google")).toBe("No key for Google. Add a gateway key or a Google key in Settings.");
    expect(missingKeyMessage("xai")).toBe("No key for xAI. Add a gateway key or an xAI key in Settings.");
    expect(routeModel("meta/llama-5", keys({}))).toEqual({
      kind: "missing-key",
      message: "No key for meta/llama-5. Add a gateway key in Settings.",
    });
  });
});

describe("browsing without a gateway key", () => {
  it("offers web search only with a gateway key", () => {
    expect(Object.keys(browsingTools(null))).toEqual(["read_page"]);
    expect(Object.keys(browsingTools("vck_test_not_used")).sort()).toEqual(["read_page", "web_search"]);
  });

  it("adds one sentence to the instructions when web search is missing", () => {
    expect(withSearchNote("Be brief.", browsingTools(null))).toBe(`Be brief.\n\n${NO_WEB_SEARCH_NOTE}`);
    expect(withSearchNote("Be brief.", browsingTools("vck_test_not_used"))).toBe("Be brief.");
    expect(withSearchNote("Be brief.", undefined)).toBe("Be brief.");
  });

  it("passes the note and only the page reader to the model", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "Hi" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      }),
    });
    const events = [];
    for await (const e of streamSpeakEvents({
      model,
      request: { modelId: "x/y", instructions: "Be brief.", messages: [{ role: "user", text: "Hi" }], browsing: true },
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
    const call = model.doStreamCalls[0];
    expect((call.tools ?? []).map((t) => t.name)).toEqual(["read_page"]);
    expect(JSON.stringify(call.prompt)).toContain("Web search is not available");
  });
});
