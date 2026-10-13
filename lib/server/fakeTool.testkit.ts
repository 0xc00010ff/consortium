// Test helper: writes a small Node script that stands in for Claude Code or
// Codex. It reads stdin, records what it was given, prints recorded JSON
// lines, and exits. Nothing here starts the real tools.

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import type { SpawnFn } from "./cli";

export interface FakeToolOptions {
  lines?: string[];
  exitCode?: number;
  stderr?: string;
  hang?: boolean; // keep running after the lines, until killed
}

export interface FakeRecord {
  argv: string[];
  cwd: string;
  files: string[];
  input: string;
  pid: number;
  env: { anthropicKey: string | null; maxOutput: string | null };
}

export interface FakeTool {
  bin: string; // an executable script, for code that spawns it directly
  spawnFn: SpawnFn; // runs the script with this Node binary, whatever the command
  record(): FakeRecord;
}

let count = 0;

// The script folders are removed when the test file that made them ends.
const folders: string[] = [];
afterAll(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

export function fakeTool(options: FakeToolOptions = {}): FakeTool {
  const dir = mkdtempSync(path.join(os.tmpdir(), "consortium-fake-"));
  folders.push(dir);
  const recordFile = path.join(dir, "record.json");
  const bin = path.join(dir, `fake-${count++}.mjs`);
  const source = `#!${process.execPath}
import { readdirSync, writeFileSync } from "node:fs";
const lines = ${JSON.stringify(options.lines ?? [])};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    files: readdirSync(process.cwd()),
    input,
    pid: process.pid,
    env: {
      anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
      maxOutput: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
    },
  }));
  for (const line of lines) process.stdout.write(line + "\\n");
  const stderr = ${JSON.stringify(options.stderr ?? "")};
  if (stderr) process.stderr.write(stderr);
  if (${options.hang ? "true" : "false"}) { setInterval(() => {}, 1000); return; }
  process.exitCode = ${options.exitCode ?? 0};
});
`;
  writeFileSync(bin, source);
  chmodSync(bin, 0o755);
  return {
    bin,
    spawnFn: (_command, args, spawnOptions) => spawn(process.execPath, [bin, ...args], spawnOptions),
    record: () => JSON.parse(readFileSync(recordFile, "utf8")) as FakeRecord,
  };
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

// ---------- Recorded output ----------

const j = (value: unknown) => JSON.stringify(value);
const ev = (event: unknown) => j({ type: "stream_event", event, session_id: "s", parent_tool_use_id: null });

// A Claude Code call with browsing on: some text, a web search, a page read
// that fails, and the answer.
export const CLAUDE_BROWSING_LINES = [
  j({ type: "system", subtype: "init", session_id: "s", tools: ["WebSearch", "WebFetch"], model: "claude-sonnet-4-5-20250929" }),
  ev({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } }),
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } }),
  j({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "Let me check." }] }, parent_tool_use_id: null }),
  ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "WebSearch", input: {} } }),
  ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"launch' } }),
  j({
    type: "assistant",
    message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_1", name: "WebSearch", input: { query: "launch checklist" } }] },
    parent_tool_use_id: null,
  }),
  ev({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
  j({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content:
            'Web search results for query: "launch checklist"\n\nLinks: [{"title":"A","url":"https://a.example"},{"title":"B","url":"https://b.example"}]\n\nSummary text.',
        },
      ],
    },
    parent_tool_use_id: null,
  }),
  ev({ type: "message_start", message: { id: "msg_2", role: "assistant", content: [] } }),
  j({
    type: "assistant",
    message: {
      id: "msg_2",
      content: [{ type: "tool_use", id: "toolu_2", name: "WebFetch", input: { url: "https://example.com/page", prompt: "Summarize" } }],
    },
    parent_tool_use_id: null,
  }),
  j({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "<tool_use_error>Fetch failed: 404</tool_use_error>" }],
    },
    parent_tool_use_id: null,
  }),
  ev({ type: "message_start", message: { id: "msg_3", role: "assistant", content: [] } }),
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here is" } }),
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " the plan." } }),
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
  j({ type: "assistant", message: { id: "msg_3", content: [{ type: "text", text: "Here is the plan." }] }, parent_tool_use_id: null }),
  j({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    num_turns: 3,
    result: "Here is the plan.",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 },
  }),
];

export const CODEX_BROWSING_LINES = [
  j({ type: "thread.started", thread_id: "t1" }),
  j({ type: "turn.started" }),
  j({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Planning**" } }),
  j({ type: "item.started", item: { id: "item_1", type: "web_search", query: "" } }),
  j({
    type: "item.completed",
    item: { id: "item_1", type: "web_search", query: "product launch checklist", action: { type: "search", query: "product launch checklist" } },
  }),
  j({ type: "item.started", item: { id: "item_2", type: "web_search", query: "", action: { type: "open_page", url: "https://example.com/guide" } } }),
  j({ type: "item.completed", item: { id: "item_2", type: "web_search", query: "", action: { type: "open_page", url: "https://example.com/guide" } } }),
  j({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: "First part." } }),
  j({ type: "item.completed", item: { id: "item_4", type: "agent_message", text: "Second part." } }),
  j({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 300 } }),
];
