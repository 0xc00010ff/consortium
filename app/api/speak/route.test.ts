import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SpeakEvent, SpeakRequest } from "@/lib/types";
import { setCliToolDetector } from "@/lib/server/cliTools";
import { CLAUDE_BROWSING_LINES, fakeTool } from "@/lib/server/fakeTool.testkit";
import { isolateSettings, removeSettingsDirs } from "@/lib/server/settingsHome.testkit";
import { POST } from "./route";

const saved = { ...process.env };

beforeAll(() => {
  isolateSettings();
  process.env.CONSORTIUM_MOCK = "1";
  process.env.CONSORTIUM_MOCK_DELAY = "0";
});

afterAll(() => {
  process.env = saved;
  removeSettingsDirs();
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function readEvents(response: Response): Promise<SpeakEvent[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SpeakEvent);
}

const seatRequest: SpeakRequest = {
  modelId: "anthropic/claude-sonnet-5.5",
  instructions: "You are Agent A at a table with agents B, C and D.",
  messages: [
    {
      role: "user",
      text: "",
      afterAttachments: "# Now\n\nRound 1. The host wrote:\n\nHow should a small team plan a product launch?",
    },
  ],
  browsing: false,
  maxOutputTokens: 8000,
  mockHint: { purpose: "seat", interaction: "group", round: 1, seatId: "A" },
};

describe("POST /api/speak in mock mode", () => {
  it("streams newline-delimited events in order and ends with done", async () => {
    const response = await post(seatRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await readEvents(response);
    expect(events.length).toBeGreaterThan(5);
    expect(events[events.length - 1].type).toBe("done");
    expect(events.slice(0, -1).every((e) => e.type === "text")).toBe(true);
    const text = events.map((e) => (e.type === "text" ? e.delta : "")).join("");
    expect(text).toContain("How should a small team plan a product launch");
    const done = events[events.length - 1];
    expect(done.type === "done" && done.usage.outputTokens).toBeGreaterThan(0);
  });

  it("sometimes starts with a tool-start and tool-end pair when browsing is on", async () => {
    let sawTools = false;
    for (let i = 0; i < 30 && !sawTools; i++) {
      const events = await readEvents(await post({ ...seatRequest, browsing: true }));
      const kinds = events.map((e) => e.type);
      if (kinds[0] !== "tool-start") continue;
      sawTools = true;
      const firstText = kinds.indexOf("text");
      const tools = events.slice(0, firstText);
      const starts = tools.filter((e) => e.type === "tool-start");
      const ends = tools.filter((e) => e.type === "tool-end");
      expect(starts.length).toBeGreaterThan(0);
      expect(ends.map((e) => e.type === "tool-end" && e.id)).toEqual(starts.map((e) => e.type === "tool-start" && e.id));
      expect(kinds[kinds.length - 1]).toBe("done");
    }
    expect(sawTools).toBe(true);
  });

  it("writes an arbiter reply as a numbered list", async () => {
    const response = await post({
      ...seatRequest,
      instructions: "You are an arbiter named Tracker at a table of AI models. The agents are called A and B.",
      messages: [
        {
          role: "user",
          text: "# Transcript\n\n## Round 1\n\n### Host\n\nPlan a launch.\n\n### Agent A\n\nStart small.\n\n### Agent B\n\nStart big.",
          afterAttachments: "# Now\n\nRound 1. The agents have answered the host. Write your reply as Tracker, following the host's instructions.",
        },
      ],
      mockHint: { purpose: "arbiter", interaction: "group", round: 1, arbiterName: "Tracker" },
    });
    const events = await readEvents(response);
    const text = events.map((e) => (e.type === "text" ? e.delta : "")).join("");
    expect(text).toMatch(/^1\. Agent A wants to /m);
    expect(text).toMatch(/^2\. Agent B wants to /m);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("rejects a missing model id or empty messages with status 400", async () => {
    const noModel = await post({ ...seatRequest, modelId: "" });
    expect(noModel.status).toBe(400);
    expect(await noModel.json()).toEqual({ error: "The request is missing a model id." });

    const noMessages = await post({ ...seatRequest, messages: [] });
    expect(noMessages.status).toBe(400);
    expect(await noMessages.json()).toEqual({ error: "The request needs at least one message." });

    const notJson = await post("{oops");
    expect(notJson.status).toBe(400);
  });
});

describe("POST /api/speak for Claude Code and Codex", () => {
  afterEach(() => {
    process.env.CONSORTIUM_MOCK = "1";
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    setCliToolDetector(null);
  });

  it("uses the sample replies in mock mode, like any other model", async () => {
    setCliToolDetector(() => {
      throw new Error("mock mode should not look for the tools");
    });
    const events = await readEvents(await post({ ...seatRequest, modelId: "cli/claude-code" }));
    expect(events[events.length - 1].type).toBe("done");
    expect(events.map((e) => (e.type === "text" ? e.delta : "")).join("")).toContain("product launch");
  });

  it("runs the installed tool and streams its reply", async () => {
    delete process.env.CONSORTIUM_MOCK;
    delete process.env.AI_GATEWAY_API_KEY;
    const fake = fakeTool({ lines: CLAUDE_BROWSING_LINES });
    setCliToolDetector(() => [{ id: "cli/claude-code", bin: fake.bin, configuredModel: null }]);
    const events = await readEvents(await post({ ...seatRequest, modelId: "cli/claude-code", browsing: true }));
    expect(events.map((e) => e.type)).toEqual(["text", "tool-start", "tool-end", "tool-start", "tool-end", "text", "text", "done"]);
    expect(fake.record().argv).toContain("WebSearch,WebFetch");
  });

  it("runs the tool with the chosen model, and drops an unsafe one", async () => {
    delete process.env.CONSORTIUM_MOCK;
    delete process.env.AI_GATEWAY_API_KEY;
    const fake = fakeTool({ lines: CLAUDE_BROWSING_LINES });
    setCliToolDetector(() => [{ id: "cli/claude-code", bin: fake.bin, configuredModel: null }]);
    await readEvents(await post({ ...seatRequest, modelId: "cli/claude-code", toolModel: "sonnet" }));
    const argv = fake.record().argv;
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    await readEvents(await post({ ...seatRequest, modelId: "cli/claude-code", toolModel: "--dangerously-skip-permissions" }));
    expect(fake.record().argv).not.toContain("--model");
    expect(fake.record().argv).not.toContain("--dangerously-skip-permissions");
  });

  it("explains a tool that is not installed", async () => {
    delete process.env.CONSORTIUM_MOCK;
    setCliToolDetector(() => []);
    const events = await readEvents(await post({ ...seatRequest, modelId: "cli/codex" }));
    expect(events).toEqual([
      { type: "error", message: "Codex was not found on this machine. Install it, or choose a different model for this agent." },
    ]);
  });

  it("refuses a gateway model without a key when a tool is installed", async () => {
    delete process.env.CONSORTIUM_MOCK;
    delete process.env.AI_GATEWAY_API_KEY;
    setCliToolDetector(() => [{ id: "cli/codex", bin: "/x/codex", configuredModel: null }]);
    const events = await readEvents(await post(seatRequest));
    expect(events).toEqual([
      { type: "error", message: "No key for Anthropic. Add a gateway key or an Anthropic key in Settings." },
    ]);
  });

  it("refuses a model whose maker has no key when another maker has one", async () => {
    delete process.env.CONSORTIUM_MOCK;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-used";
    setCliToolDetector(() => []);
    const events = await readEvents(await post({ ...seatRequest, modelId: "openai/gpt-6.1-sol" }));
    expect(events).toEqual([{ type: "error", message: "No key for OpenAI. Add a gateway key or an OpenAI key in Settings." }]);
  });

  it("keeps sample replies for gateway models without a key when no tool is installed", async () => {
    delete process.env.CONSORTIUM_MOCK;
    delete process.env.AI_GATEWAY_API_KEY;
    setCliToolDetector(() => []);
    const events = await readEvents(await post(seatRequest));
    expect(events[events.length - 1].type).toBe("done");
  });
});
