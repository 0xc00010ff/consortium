// Tests the real-model path (streamText to SpeakEvents) with a mock language
// model, so it runs without a gateway key.

import { simulateReadableStream, tool, type TextStreamPart, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SpeakEvent, SpeakRequest } from "@/lib/types";
import { describeModelError, describeToolOutput, streamSpeakEvents, toModelMessages, toolLabel, toSpeakEvents } from "./gateway";

type StreamPart = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer T> ? T : never;

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

async function collect(events: AsyncGenerator<SpeakEvent>): Promise<SpeakEvent[]> {
  const out: SpeakEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const request: SpeakRequest = {
  modelId: "test/model",
  instructions: "Be brief.",
  messages: [{ role: "user", text: "Read the page." }],
  browsing: true,
  maxOutputTokens: 100,
};

describe("streamSpeakEvents", () => {
  it("turns tool calls, text and usage into speak events", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        const chunks: StreamPart[] =
          call === 1
            ? [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "call-1",
                  toolName: "read_page",
                  input: JSON.stringify({ url: "http://localhost:3000/about" }),
                },
                { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: usage(10, 5) },
              ]
            : [
                { type: "stream-start" as const, warnings: [] },
                { type: "text-start" as const, id: "t1" },
                { type: "text-delta" as const, id: "t1", delta: "The page " },
                { type: "text-delta" as const, id: "t1", delta: "says hello." },
                { type: "text-end" as const, id: "t1" },
                { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage(20, 7) },
              ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    const readPage = tool({
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => ({ url, title: "About us", text: "Hello.", truncated: false }),
    });

    const events = await collect(
      streamSpeakEvents({ model, request, signal: new AbortController().signal, tools: { read_page: readPage } }),
    );

    expect(events.slice(0, 4)).toEqual([
      { type: "tool-start", id: "call-1", tool: "read_page", label: "http://localhost:3000/about" },
      { type: "tool-end", id: "call-1", ok: true, detail: "About us" },
      { type: "text", delta: "The page " },
      { type: "text", delta: "says hello." },
    ]);
    const done = events[4];
    expect(done.type).toBe("done");
    expect(done.type === "done" && done.usage).toEqual({ inputTokens: 30, outputTokens: 12 });
    expect(done.type === "done" && done.finishReason).toBe("stop");
    expect(events).toHaveLength(5);

    // The instructions, the output limit and the tools reach the model.
    const options = model.doStreamCalls[0];
    expect(options.maxOutputTokens).toBe(100);
    expect(JSON.stringify(options.prompt)).toContain("Be brief.");
    expect(options.tools?.map((t) => t.name)).toEqual(["read_page"]);
  });

  it("keeps text written before and after a tool call apart", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        const chunks: StreamPart[] =
          call === 1
            ? [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "a" },
                { type: "text-delta", id: "a", delta: "Let me check." },
                { type: "text-end", id: "a" },
                { type: "tool-call", toolCallId: "c1", toolName: "read_page", input: JSON.stringify({ url: "http://localhost/x" }) },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(5, 5) },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "b" },
                { type: "text-delta", id: "b", delta: "Found it." },
                { type: "text-end", id: "b" },
                { type: "finish", finishReason: { unified: "length", raw: "max_tokens" }, usage: usage(5, 5) },
              ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    const readPage = tool({
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => ({ url, title: "X", text: "x", truncated: false }),
    });
    const events = await collect(
      streamSpeakEvents({ model, request, signal: new AbortController().signal, tools: { read_page: readPage } }),
    );
    const text = events.map((e) => (e.type === "text" ? e.delta : "")).join("");
    expect(text).toBe("Let me check.\n\nFound it.");
    const done = events[events.length - 1];
    expect(done.type === "done" && done.finishReason).toBe("length");
  });

  it("marks a stream that ends without a finish part as unknown", async () => {
    async function* parts(): AsyncGenerator<TextStreamPart<ToolSet>> {
      yield { type: "text-start", id: "t" };
      yield { type: "text-delta", id: "t", text: "Partial answer" };
    }
    const events = await collect(
      toSpeakEvents(parts(), { modelId: "test/model", signal: new AbortController().signal, started: Date.now() }),
    );
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
    const done = events[1];
    expect(done.type === "done" && done.finishReason).toBe("unknown");
  });

  it("sends no tools when browsing is off", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "t" },
            { type: "text-delta" as const, id: "t", delta: "Hi." },
            { type: "text-end" as const, id: "t" },
            { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage(3, 1) },
          ],
        }),
      }),
    });
    const events = await collect(
      streamSpeakEvents({ model, request: { ...request, browsing: false }, signal: new AbortController().signal }),
    );
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
    expect(model.doStreamCalls[0].tools ?? []).toEqual([]);
  });

  it("emits one plain error event when the model call fails", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
      },
    });
    const events = await collect(
      streamSpeakEvents({ model, request: { ...request, browsing: false }, signal: new AbortController().signal }),
    );
    expect(events).toEqual([
      {
        type: "error",
        message: "The AI Gateway did not accept the API key. Check AI_GATEWAY_API_KEY in .env.local, then restart the server.",
      },
    ]);
  });
});

describe("helpers", () => {
  it("converts attachments to file parts placed between the two text parts", () => {
    const [message] = toModelMessages([
      {
        role: "user",
        text: "# Motion",
        attachments: [{ id: "1", name: "a.png", mediaType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }],
        afterAttachments: "# Your turn",
      },
    ]);
    expect(message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "# Motion" },
        { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" },
        { type: "text", text: "# Your turn" },
      ],
    });
  });

  it("labels tool calls with the query or the URL", () => {
    expect(toolLabel("web_search", { objective: "Find studies", search_queries: ["remote work productivity"] })).toBe(
      "remote work productivity",
    );
    expect(toolLabel("web_search", { objective: "Find studies on remote work" })).toBe("Find studies on remote work");
    expect(toolLabel("read_page", { url: "https://example.org" })).toBe("https://example.org");
  });

  it("describes tool results and failures", () => {
    expect(describeToolOutput("web_search", { searchId: "x", results: [{}, {}, {}] })).toEqual({ ok: true, detail: "3 results" });
    expect(describeToolOutput("web_search", { error: "rate_limit", message: "Too many searches." })).toEqual({
      ok: false,
      detail: "Too many searches.",
    });
    expect(describeToolOutput("read_page", { url: "u", error: "The page returned status 404." })).toEqual({
      ok: false,
      detail: "The page returned status 404.",
    });
  });

  it("writes plain error messages for common gateway failures", () => {
    expect(describeModelError({ type: "model_not_found", statusCode: 404 }, "x/y")).toBe(
      "The AI Gateway does not offer the model x/y. Choose a different model.",
    );
    expect(describeModelError({ statusCode: 429 }, "x/y")).toContain("limiting requests");
    expect(describeModelError(new Error("Something odd"), "x/y")).toBe("The call to x/y failed. Something odd");
  });
});
