import { describe, expect, it } from "vitest";
import type { ModelsResponse } from "@/lib/types";
import { newArbiter, newSeat, newTable, SUMMARIZER_INSTRUCTIONS, titleFrom } from "./table";
import { makeRound, makeTable } from "./test-helpers";

const models: ModelsResponse = {
  mock: true,
  models: [
    { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", maker: "anthropic" },
    { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", maker: "anthropic" },
    { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", maker: "openai" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", maker: "google" },
    { id: "spacexai/grok-4.7", name: "Grok 4.7", maker: "xai" },
  ],
  defaults: {
    seats: ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol", "google/gemini-3.1-pro-preview", "spacexai/grok-4.7"],
    arbiter: "anthropic/claude-haiku-5.5",
  },
};

describe("newTable", () => {
  it("opens with four seats from the defaults, a Summarizer arbiter and Group interaction", () => {
    const table = newTable(models, models.models);
    expect(table.title).toBe("Untitled table");
    expect(table.interaction).toBe("group");
    expect(table.arbiters).toEqual([
      {
        id: "arbiter-1",
        name: "Summarizer",
        modelId: "anthropic/claude-haiku-5.5",
        modelName: "Claude Haiku 5.5",
        maker: "anthropic",
        browsing: false,
        instructions: SUMMARIZER_INSTRUCTIONS,
      },
    ]);
    expect(table.rounds).toEqual([]);
    expect(table.privateThreads).toEqual({});
    expect(table.seats).toEqual([
      { id: "A", modelId: "anthropic/claude-sonnet-5.5", modelName: "Claude Sonnet 5.5", maker: "anthropic", browsing: true },
      { id: "B", modelId: "openai/gpt-6.1-sol", modelName: "GPT-6.1 Sol", maker: "openai", browsing: true },
      { id: "C", modelId: "google/gemini-3.1-pro-preview", modelName: "Gemini 3.1 Pro Preview", maker: "google", browsing: true },
      { id: "D", modelId: "spacexai/grok-4.7", modelName: "Grok 4.7", maker: "xai", browsing: true },
    ]);
    expect(newTable(models, models.models).id).not.toBe(table.id);
  });

  it("makes one agent per default model, and takes the first four models without defaults", () => {
    const one = newTable({ ...models, defaults: { ...models.defaults, seats: ["openai/gpt-6.1-sol"] } }, models.models);
    expect(one.seats.map((s) => `${s.id} ${s.modelId}`)).toEqual(["A openai/gpt-6.1-sol"]);
    const none = newTable({ ...models, defaults: { ...models.defaults, seats: [] } }, models.models);
    expect(none.seats.map((s) => s.id)).toEqual(["A", "B", "C", "D"]);
    expect(none.seats[0].modelId).toBe(models.models[0].id);
  });
});

describe("titleFrom", () => {
  it("uses the first few words of the first message", () => {
    expect(titleFrom("Pricing ideas for Habitly")).toBe("Pricing ideas for Habitly");
    expect(titleFrom("Cities should make public transport free.")).toBe("Cities should make public transport free");
    expect(titleFrom("What should we build first? We have one quarter.")).toBe("What should we build first?");
    expect(titleFrom("How should a small team plan its first product launch next spring?")).toBe(
      "How should a small team plan its…",
    );
    expect(titleFrom("## Review this\n\nThe checkout screen")).toBe("Review this");
    expect(titleFrom("   ")).toBe("Untitled table");
  });
});

describe("new participants", () => {
  it("gives a new seat a letter that has not been used at the table", () => {
    const table = makeTable();
    table.rounds = [makeRound(table, 1, "Start")];
    table.seats = table.seats.filter((s) => s.id !== "B");
    expect(newSeat(table, "openai/gpt-6.1-sol", models.models)).toMatchObject({ id: "E", modelName: "GPT-6.1 Sol", browsing: true });
  });

  it("names new arbiters Arbiter 1, Arbiter 2, with browsing off", () => {
    const table = makeTable();
    const first = newArbiter(table, models.defaults.arbiter, models.models);
    expect(first).toMatchObject({ id: "arbiter-1", name: "Arbiter 1", modelName: "Claude Haiku 5.5", browsing: false, instructions: "" });
    const second = newArbiter({ ...table, arbiters: [first] }, models.defaults.arbiter, models.models);
    expect(second).toMatchObject({ id: "arbiter-2", name: "Arbiter 2" });
  });
});
