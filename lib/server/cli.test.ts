import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SpeakEvent, SpeakRequest } from "@/lib/types";
import {
  claudeArgs,
  claudeInput,
  ClaudeTranslator,
  cliSpeakEvents,
  codexArgs,
  codexPrompt,
  CodexTranslator,
  promptParts,
  type ExitInfo,
} from "./cli";
import { CLAUDE_CODE_ID, CODEX_ID, forgetSeenModels, getCliTools, cliModelInfos, setCliToolDetector } from "./cliTools";
import { CLAUDE_BROWSING_LINES, CODEX_BROWSING_LINES, fakeTool, isRunning, waitUntil } from "./fakeTool.testkit";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const request = (overrides: Partial<SpeakRequest> = {}): SpeakRequest => ({
  modelId: CLAUDE_CODE_ID,
  instructions: "You are Agent A.",
  messages: [
    {
      role: "user",
      text: "# Transcript\n\nThe host asked about a launch.",
      attachments: [{ id: "1", name: "chart.png", mediaType: "image/png", dataUrl: PNG }],
      afterAttachments: "# Now\n\nRound 1.",
    },
  ],
  browsing: false,
  ...overrides,
});

const cleanExit: ExitInfo = { code: 0, signal: null, error: null, stderr: "" };

async function collect(events: AsyncGenerator<SpeakEvent>): Promise<SpeakEvent[]> {
  const out: SpeakEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function translate(translator: ClaudeTranslator | CodexTranslator, lines: string[], exit = cleanExit): SpeakEvent[] {
  const events = lines.flatMap((line) => translator.line(line));
  events.push(translator.finish(exit, 42));
  return events;
}

afterEach(() => {
  forgetSeenModels();
  setCliToolDetector(null);
});

describe("the prompt", () => {
  it("keeps the text, the images and the text after them in order", () => {
    const parts = promptParts(request().messages);
    expect(parts.map((p) => p.type)).toEqual(["text", "image", "text"]);
    expect(parts[1]).toEqual({ type: "image", name: "chart.png", mediaType: "image/png", data: "iVBORw0KGgo=" });
  });

  it("notes an image it cannot pass on", () => {
    const parts = promptParts([
      { role: "user", text: "Look", attachments: [{ id: "1", name: "a.svg", mediaType: "image/svg+xml", dataUrl: "data:image/svg+xml,<svg/>" }] },
    ]);
    expect(parts[1]).toEqual({ type: "text", text: '(The image "a.svg" could not be passed on.)' });
  });

  it("labels the turns when there is more than one", () => {
    const parts = promptParts([
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello" },
      { role: "user", text: "Go on" },
    ]);
    expect(parts.map((p) => (p.type === "text" ? p.text : ""))).toEqual([
      "## User", "Hi", "## Your earlier reply", "Hello", "## User", "Go on",
    ]);
  });

  it("sends Claude Code one user message with image blocks", () => {
    const message = JSON.parse(claudeInput(promptParts(request().messages)));
    expect(message.type).toBe("user");
    expect(message.message.role).toBe("user");
    expect(message.message.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  it("puts the instructions first for Codex, under a heading", () => {
    const prompt = codexPrompt("Be brief.", promptParts(request().messages));
    expect(prompt).toBe(
      "# Instructions\n\nBe brief.\n\n# Conversation\n\n# Transcript\n\nThe host asked about a launch.\n\n(Image 1 is attached: chart.png)\n\n# Now\n\nRound 1.\n",
    );
  });
});

describe("Claude Code arguments", () => {
  it("turns every tool off when browsing is off", () => {
    const args = claudeArgs(request());
    expect(args.slice(0, 3)).toEqual(["-p", "--input-format", "stream-json"]);
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--safe-mode");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--model");
    expect(args).toContain("--system-prompt=You are Agent A.");
    expect(claudeArgs(request({ instructions: "- Be brief." }))).toContain("--system-prompt=- Be brief.");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("8");
    expect(args.slice(-2)).toEqual(["--tools", ""]);
  });

  it("allows only web search and page fetching when browsing is on", () => {
    const args = claudeArgs(request({ browsing: true }));
    expect(args.slice(-4)).toEqual(["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch"]);
  });

  it("adds --model with a chosen tool model, and nothing for an unsafe one", () => {
    const args = claudeArgs(request({ toolModel: "opus" }));
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args.filter((a) => a === "--model")).toHaveLength(1);
    expect(args.slice(-2)).toEqual(["--tools", ""]);
    expect(claudeArgs(request({ toolModel: "--bare" }))).not.toContain("--model");
  });
});

describe("Codex arguments", () => {
  const config = 'model = "gpt-6-astra"\n\n[mcp_servers.node_repl]\ncommand = "x"\n[mcp_servers.node_repl.env]\nA = "1"\n[mcp_servers."computer-use"]\n';

  it("runs read-only in the folder, with search off and MCP servers off", () => {
    const args = codexArgs(request({ modelId: CODEX_ID }), { dir: "/tmp/x", images: [], config });
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--skip-git-repo-check");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args[args.indexOf("-C") + 1]).toBe("/tmp/x");
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain("mcp_servers.node_repl.enabled=false");
    expect(args).toContain("mcp_servers.computer-use.enabled=false");
    expect(args).not.toContain("-m");
  });

  it("turns live search on with browsing and passes images last", () => {
    const args = codexArgs(request({ modelId: CODEX_ID, browsing: true }), {
      dir: "/tmp/x",
      images: [{ file: "/tmp/x/image-1.png", name: "chart.png" }],
      config: "",
    });
    expect(args).toContain('web_search="live"');
    expect(args.slice(-2)).toEqual(["-i", "/tmp/x/image-1.png"]);
  });

  it("adds -m with a chosen tool model, before the images", () => {
    const args = codexArgs(request({ modelId: CODEX_ID, toolModel: "gpt-6.1-sol" }), {
      dir: "/tmp/x",
      images: [{ file: "/tmp/x/image-1.png", name: "chart.png" }],
      config: "",
    });
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
    expect(args.slice(-2)).toEqual(["-i", "/tmp/x/image-1.png"]);
    expect(codexArgs(request({ modelId: CODEX_ID, toolModel: "-c" }), { dir: "/tmp/x", images: [], config: "" })).not.toContain("-m");
  });
});

describe("Claude Code output", () => {
  it("streams text, maps web search and page reads, and ends with usage", () => {
    const models: string[] = [];
    const events = translate(new ClaudeTranslator((m) => models.push(m)), CLAUDE_BROWSING_LINES);
    expect(models).toEqual(["claude-sonnet-4-5-20250929"]);
    expect(events).toEqual([
      { type: "text", delta: "Let me check." },
      { type: "tool-start", id: "toolu_1", tool: "web_search", label: "launch checklist" },
      { type: "tool-end", id: "toolu_1", ok: true, detail: "2 results" },
      { type: "tool-start", id: "toolu_2", tool: "read_page", label: "https://example.com/page" },
      { type: "tool-end", id: "toolu_2", ok: false, detail: "Fetch failed: 404" },
      { type: "text", delta: "\n\nHere is" },
      { type: "text", delta: " the plan." },
      { type: "done", usage: { inputTokens: 1110, outputTokens: 50 }, durationMs: 42, finishReason: "stop" },
    ]);
  });

  it("uses the full message text when no deltas arrived", () => {
    const events = translate(new ClaudeTranslator(), [
      JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "Whole reply." }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "max_tokens", usage: { output_tokens: 3 } }),
    ]);
    expect(events).toEqual([
      { type: "text", delta: "Whole reply." },
      { type: "done", usage: { inputTokens: undefined, outputTokens: 3 }, durationMs: 42, finishReason: "length" },
    ]);
  });

  it("ignores lines from subagents", () => {
    const translator = new ClaudeTranslator();
    const line = JSON.stringify({
      type: "stream_event",
      parent_tool_use_id: "toolu_9",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "inner" } },
    });
    expect(translator.line(line)).toEqual([]);
  });

  it("reports an error result in plain words", () => {
    const events = translate(new ClaudeTranslator(), [
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 Overloaded" }),
    ]);
    expect(events.at(-1)).toEqual({ type: "error", message: "Claude Code reported: API Error: 529 Overloaded" });
  });

  it("says when Claude Code is not signed in", () => {
    const events = translate(new ClaudeTranslator(), [
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }),
    ]);
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Claude Code is not signed in. Run claude in a terminal and sign in with /login, then try again.",
    });
  });

  it("keeps partial text when the turn limit is reached, and explains an empty one", () => {
    const limit = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, usage: {} });
    const withText = translate(new ClaudeTranslator(), [
      JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "Partial." }] } }),
      limit,
    ]);
    expect(withText.at(-1)).toMatchObject({ type: "done", finishReason: "max-turns" });
    const empty = translate(new ClaudeTranslator(), [limit]);
    expect(empty.at(-1)).toMatchObject({ type: "error" });
    expect((empty.at(-1) as { message: string }).message).toContain("used all 8 of its turns");
  });

  it("maps a non-zero exit with no result to the exit code and the end of stderr", () => {
    const events = translate(new ClaudeTranslator(), [], { code: 1, signal: null, error: null, stderr: "boot\nError: bad flag\n" });
    expect(events).toEqual([{ type: "error", message: "Claude Code exited with code 1: boot Error: bad flag" }]);
  });

  it("maps output that cannot be read to an error", () => {
    const events = translate(new ClaudeTranslator(), ["not json at all"]);
    expect(events).toEqual([{ type: "error", message: "Claude Code sent output that could not be read: not json at all" }]);
  });
});

describe("Codex output", () => {
  it("emits each message, maps searches and page reads, and ends with usage", () => {
    const events = translate(new CodexTranslator(), CODEX_BROWSING_LINES);
    expect(events).toEqual([
      { type: "tool-start", id: "item_1", tool: "web_search", label: "product launch checklist" },
      { type: "tool-end", id: "item_1", ok: true },
      { type: "tool-start", id: "item_2", tool: "read_page", label: "https://example.com/guide" },
      { type: "tool-end", id: "item_2", ok: true },
      { type: "text", delta: "First part." },
      { type: "text", delta: "\n\nSecond part." },
      { type: "done", usage: { inputTokens: 2000, outputTokens: 300 }, durationMs: 42, finishReason: "stop" },
    ]);
  });

  it("reports a failed turn", () => {
    const events = translate(new CodexTranslator(), [
      JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }),
      JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } }),
    ]);
    expect(events).toEqual([{ type: "error", message: "Codex reported: You've hit your usage limit." }]);
  });

  it("uses the last error event when the process exits early", () => {
    const events = translate(new CodexTranslator(), [JSON.stringify({ type: "error", message: "stream disconnected" })], {
      code: 1,
      signal: null,
      error: null,
      stderr: "noise",
    });
    expect(events).toEqual([{ type: "error", message: "Codex exited with code 1: stream disconnected" }]);
  });
});

describe("running the tool", () => {
  it("runs Claude Code in an empty folder, sends the prompt on stdin, and removes the folder", async () => {
    const fake = fakeTool({ lines: CLAUDE_BROWSING_LINES });
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "should-not-reach-the-tool";
    try {
      const events = await collect(
        cliSpeakEvents({
          request: request({ browsing: true, maxOutputTokens: 8000 }),
          signal: new AbortController().signal,
          tool: { id: CLAUDE_CODE_ID, bin: "claude" },
          spawnFn: fake.spawnFn,
        }),
      );
      expect(events.map((e) => e.type)).toEqual([
        "text", "tool-start", "tool-end", "tool-start", "tool-end", "text", "text", "done",
      ]);
      const record = fake.record();
      expect(record.argv).toEqual(claudeArgs(request({ browsing: true })));
      expect(record.files).toEqual([]);
      expect(record.cwd).toContain("consortium-");
      expect(existsSync(record.cwd)).toBe(false);
      expect(JSON.parse(record.input)).toEqual(JSON.parse(claudeInput(promptParts(request().messages))));
      expect(record.env.anthropicKey).toBeNull();
      expect(record.env.maxOutput).toBe("8000");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("shows the model from a real call in the list from then on", async () => {
    const fake = fakeTool({ lines: CLAUDE_BROWSING_LINES });
    setCliToolDetector(() => [{ id: CLAUDE_CODE_ID, bin: "claude", configuredModel: null }]);
    expect(cliModelInfos(getCliTools())[0].defaultModel).toBe("default model");
    await collect(
      cliSpeakEvents({ request: request(), signal: new AbortController().signal, tool: { id: CLAUDE_CODE_ID, bin: "claude" }, spawnFn: fake.spawnFn }),
    );
    expect(cliModelInfos(getCliTools())[0].defaultModel).toBe("Sonnet 4.5");
  });

  it("passes a chosen model to each tool, and keeps the list's default label unchanged", async () => {
    setCliToolDetector(() => [{ id: CLAUDE_CODE_ID, bin: "claude", configuredModel: null }]);
    const claude = fakeTool({ lines: CLAUDE_BROWSING_LINES });
    await collect(
      cliSpeakEvents({
        request: request({ toolModel: "haiku" }),
        signal: new AbortController().signal,
        tool: { id: CLAUDE_CODE_ID, bin: "claude" },
        spawnFn: claude.spawnFn,
      }),
    );
    const claudeArgv = claude.record().argv;
    expect(claudeArgv.slice(claudeArgv.indexOf("--model"), claudeArgv.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
    expect(cliModelInfos(getCliTools())[0].defaultModel).toBe("default model");

    const codex = fakeTool({ lines: CODEX_BROWSING_LINES });
    await collect(
      cliSpeakEvents({
        request: request({ modelId: CODEX_ID, toolModel: "gpt-6-luna" }),
        signal: new AbortController().signal,
        tool: { id: CODEX_ID, bin: "codex" },
        spawnFn: codex.spawnFn,
        codexConfig: "",
      }),
    );
    const codexArgv = codex.record().argv;
    expect(codexArgv.slice(codexArgv.indexOf("-m"), codexArgv.indexOf("-m") + 2)).toEqual(["-m", "gpt-6-luna"]);
  });

  it("passes no model flag to either tool without a chosen model", async () => {
    const claude = fakeTool({ lines: CLAUDE_BROWSING_LINES });
    await collect(
      cliSpeakEvents({ request: request(), signal: new AbortController().signal, tool: { id: CLAUDE_CODE_ID, bin: "claude" }, spawnFn: claude.spawnFn }),
    );
    expect(claude.record().argv).not.toContain("--model");
    const codex = fakeTool({ lines: CODEX_BROWSING_LINES });
    await collect(
      cliSpeakEvents({
        request: request({ modelId: CODEX_ID }),
        signal: new AbortController().signal,
        tool: { id: CODEX_ID, bin: "codex" },
        spawnFn: codex.spawnFn,
        codexConfig: "",
      }),
    );
    expect(codex.record().argv).not.toContain("-m");
    expect(codex.record().argv).not.toContain("--model");
  });

  it("writes Codex images into the folder, passes them with -i, and deletes them", async () => {
    const fake = fakeTool({ lines: CODEX_BROWSING_LINES });
    const events = await collect(
      cliSpeakEvents({
        request: request({ modelId: CODEX_ID }),
        signal: new AbortController().signal,
        tool: { id: CODEX_ID, bin: "codex" },
        spawnFn: fake.spawnFn,
        codexConfig: "",
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 2000, outputTokens: 300 } });
    const record = fake.record();
    expect(record.files).toEqual(["image-1.png"]);
    const [flag, image] = record.argv.slice(-2);
    expect(flag).toBe("-i");
    expect(path.basename(image)).toBe("image-1.png");
    expect(path.basename(record.cwd)).toBe(path.basename(path.dirname(image)));
    expect(record.input.startsWith("# Instructions\n\nYou are Agent A.")).toBe(true);
    expect(existsSync(record.cwd)).toBe(false);
    expect(existsSync(image)).toBe(false);
  });

  it("maps a non-zero exit to an error with the end of stderr", async () => {
    const fake = fakeTool({ exitCode: 2, stderr: "error: unexpected argument '--safe-mode' found\n" });
    const events = await collect(
      cliSpeakEvents({ request: request(), signal: new AbortController().signal, tool: { id: CLAUDE_CODE_ID, bin: "claude" }, spawnFn: fake.spawnFn }),
    );
    expect(events).toEqual([
      { type: "error", message: "Claude Code exited with code 2: error: unexpected argument '--safe-mode' found" },
    ]);
  });

  it("says when the command cannot be started", async () => {
    const events = await collect(
      cliSpeakEvents({ request: request(), signal: new AbortController().signal, tool: { id: CODEX_ID, bin: "/nonexistent/codex" }, codexConfig: "" }),
    );
    expect(events).toEqual([{ type: "error", message: "Codex could not be started. The command was not found." }]);
  });

  it("kills the process when the request is aborted", async () => {
    const fake = fakeTool({
      lines: [JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "Starting." }] } })],
      hang: true,
    });
    const controller = new AbortController();
    const events = cliSpeakEvents({ request: request(), signal: controller.signal, tool: { id: CLAUDE_CODE_ID, bin: "claude" }, spawnFn: fake.spawnFn });
    expect((await events.next()).value).toEqual({ type: "text", delta: "Starting." });
    const { pid, cwd } = fake.record();
    expect(isRunning(pid)).toBe(true);
    controller.abort();
    expect(await events.next()).toEqual({ value: undefined, done: true });
    expect(await waitUntil(() => !isRunning(pid))).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it("kills the process when the reader stops early", async () => {
    const fake = fakeTool({
      lines: [JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "Starting." }] } })],
      hang: true,
    });
    const events = cliSpeakEvents({
      request: request(),
      signal: new AbortController().signal,
      tool: { id: CLAUDE_CODE_ID, bin: "claude" },
      spawnFn: fake.spawnFn,
    });
    await events.next();
    const { pid } = fake.record();
    await events.return(undefined);
    expect(await waitUntil(() => !isRunning(pid))).toBe(true);
  });
});
