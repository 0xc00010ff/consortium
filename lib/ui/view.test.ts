import { describe, expect, it } from "vitest";
import type { ModelInfo, Seat } from "@/lib/types";
import { defaultThinkingLabel, showsThinking, thinkingChoices, thinkingLabel, withModel, withToolModel } from "./view";

const LEVELS = ["low", "medium", "high", "xhigh", "max"];

const models: ModelInfo[] = [
  {
    id: "cli/codex",
    name: "Codex",
    maker: "openai",
    defaultModel: "gpt-6.1-sol",
    toolModels: [
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", thinkingLevels: [...LEVELS, "ultra"], defaultThinking: "low" },
      { id: "gpt-6-luna", name: "GPT-6 Luna", thinkingLevels: LEVELS },
      { id: "gpt-6-old", name: "GPT-6 Old" },
    ],
    thinkingLevels: [...LEVELS, "ultra"],
    defaultThinking: "low",
  },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", maker: "anthropic", thinkingLevels: ["none", ...LEVELS] },
  { id: "google/gemini-4-carbon", name: "Gemini 4 Carbon", maker: "google", thinkingLevels: ["low", "medium", "high"] },
  { id: "meta/llama-5", name: "Llama 5", maker: "openai" },
];

const seat = (extra: Partial<Seat>): Seat => ({ id: "A", modelId: "cli/codex", modelName: "Codex", maker: "openai", browsing: true, ...extra });

describe("thinking choices", () => {
  it("lists a tool model's own levels, or the tool's when it has none", () => {
    expect(thinkingChoices(seat({}), models)).toEqual({ levels: [...LEVELS, "ultra"], defaultLevel: "low" });
    expect(thinkingChoices(seat({ toolModel: "gpt-6-luna" }), models)).toEqual({ levels: LEVELS, defaultLevel: undefined });
    expect(thinkingChoices(seat({ toolModel: "gpt-6-old" }), models).levels).toEqual([...LEVELS, "ultra"]);
    expect(thinkingChoices(seat({ modelId: "google/gemini-4-carbon" }), models).levels).toEqual(["low", "medium", "high"]);
    expect(thinkingChoices(seat({ modelId: "meta/llama-5" }), models).levels).toEqual([]);
    expect(thinkingChoices(seat({ modelId: "gone/model" }), models).levels).toEqual([]);
  });

  it("shows the select when the model offers levels, or a level is stored", () => {
    expect(showsThinking(seat({}), models)).toBe(true);
    expect(showsThinking(seat({ modelId: "meta/llama-5" }), models)).toBe(false);
    expect(showsThinking(seat({ modelId: "meta/llama-5", thinking: "high" }), models)).toBe(true);
  });

  it("keeps the level across a model change only when the new model offers it", () => {
    const high = seat({ modelId: "anthropic/claude-haiku-5.5", modelName: "Claude Haiku 5.5", maker: "anthropic", thinking: "high" });
    expect(withModel(high, models, "google/gemini-4-carbon").thinking).toBe("high");
    const max = { ...high, thinking: "max" };
    expect(withModel(max, models, "google/gemini-4-carbon").thinking).toBeUndefined();
    expect(withModel(max, models, "meta/llama-5").thinking).toBeUndefined();
    expect(withModel(max, models, "cli/codex").thinking).toBe("max");

    const ultra = seat({ toolModel: "gpt-6.1-sol", thinking: "ultra" });
    expect(withToolModel(ultra, models, "gpt-6-luna")).toMatchObject({ toolModel: "gpt-6-luna", thinking: undefined });
    expect(withToolModel(ultra, models, undefined)).toMatchObject({ toolModel: undefined, thinking: "ultra" });
  });
});

describe("thinking labels", () => {
  it("name each level with its own label", () => {
    expect(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(thinkingLabel)).toEqual([
      "No thinking",
      "Minimal thinking",
      "Low thinking",
      "Medium thinking",
      "High thinking",
      "Extra high thinking",
      "Max thinking",
      "Ultra thinking",
    ]);
    expect(thinkingLabel("deep_think")).toBe("Deep think thinking");
  });

  it("say the default level when it is known", () => {
    expect(defaultThinkingLabel(undefined)).toBe("Default thinking");
    expect(defaultThinkingLabel("high")).toBe("Default thinking (high)");
    expect(defaultThinkingLabel("xhigh")).toBe("Default thinking (extra high)");
  });
});
