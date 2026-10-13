// Calls to Claude Code and Codex, which run on this machine and bill the
// host's own subscriptions. Each call starts the tool once in a fresh, empty
// folder, sends the prompt on stdin, and translates the tool's JSON lines
// into SpeakEvents. Stopping the table, or the 5 minute limit, ends the
// process.
//
// Claude Code:
//   claude -p --input-format stream-json --output-format stream-json
//     --verbose --include-partial-messages --no-session-persistence
//     --safe-mode --strict-mcp-config --disable-slash-commands
//     --permission-prompts none --max-turns 8 [--model <tool model>]
//     --system-prompt=<instructions>
//     --tools ""                                   (browsing off)
//     --tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch  (browsing on)
//
// Codex:
//   codex exec --json --skip-git-repo-check --ephemeral --sandbox read-only
//     --color never -C <folder> [-m <tool model>] -c approval_policy="never"
//     -c web_search="live" | -c web_search="disabled"
//     -c features.<name>=false ...  -c mcp_servers.<name>.enabled=false ...
//     -i <image> ...

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ChatTurn, SpeakEvent, SpeakRequest, ToolName, Usage } from "@/lib/types";
import { CLAUDE_CODE_ID, codexMcpServerNames, isToolModelId, readCodexConfig, rememberModel, type CliTool } from "./cliTools";
import { toolLabel } from "./gateway";

export const CLAUDE_MAX_TURNS = 8; // a few searches and page reads, then the answer
const STDERR_KEEP = 4000;
const TAIL_CHARS = 300;
const DETAIL_LIMIT = 140;
const KILL_GRACE_MS = 3000;

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface CliSpeakOptions {
  request: SpeakRequest;
  signal: AbortSignal;
  tool: Pick<CliTool, "id" | "bin">;
  spawnFn?: SpawnFn; // replaced in tests
  codexConfig?: string; // the text of Codex's config.toml; read from disk when absent
}

export async function* cliSpeakEvents({
  request,
  signal,
  tool,
  spawnFn = spawn,
  codexConfig,
}: CliSpeakOptions): AsyncGenerator<SpeakEvent> {
  const started = Date.now();
  const toolName = tool.id === CLAUDE_CODE_ID ? "Claude Code" : "Codex";
  let dir: string | null = null;
  let lines: AsyncGenerator<string, ExitInfo> | null = null;
  try {
    // An empty folder, so the tool reads no project files and no CLAUDE.md.
    dir = await mkdtemp(path.join(os.tmpdir(), "consortium-"));
    const parts = promptParts(request.messages);

    let args: string[];
    let stdin: string;
    let translator: Translator;
    const env = childEnv();
    if (tool.id === CLAUDE_CODE_ID) {
      args = claudeArgs(request);
      stdin = claudeInput(parts);
      if (request.maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.maxOutputTokens);
      // The list shows the model a call names as the tool's default, so a call
      // with a chosen model leaves it alone.
      const chosen = isToolModelId(request.toolModel);
      translator = new ClaudeTranslator((model) => {
        if (!chosen) rememberModel(CLAUDE_CODE_ID, model);
      });
    } else {
      const images = await writeImages(parts, dir);
      args = codexArgs(request, { dir, images, config: codexConfig ?? readCodexConfig() });
      stdin = codexPrompt(request.instructions, parts);
      translator = new CodexTranslator();
    }

    lines = runLines({ command: tool.bin, args, cwd: dir, env, stdin, signal, spawnFn });
    let next = await lines.next();
    while (!next.done) {
      for (const event of translator.line(next.value)) yield event;
      next = await lines.next();
    }
    if (signal.aborted) return;
    yield translator.finish(next.value, Date.now() - started);
  } catch (err) {
    if (signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message: `${toolName} could not be started. ${message}` };
  } finally {
    // Ends the process if the reader stopped early.
    await lines?.return(undefined as never).catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- The prompt ----------

export type PromptPart =
  | { type: "text"; text: string }
  | { type: "image"; name: string; mediaType: string; data: string }; // base64

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// One user message, as both tools take it: text, then images, then the text
// that follows the images. Earlier turns, if any, are written out with labels.
export function promptParts(turns: ChatTurn[]): PromptPart[] {
  const parts: PromptPart[] = [];
  const label = turns.length > 1;
  for (const turn of turns) {
    if (label) parts.push({ type: "text", text: turn.role === "user" ? "## User" : "## Your earlier reply" });
    if (turn.text.trim()) parts.push({ type: "text", text: turn.text });
    for (const attachment of turn.attachments ?? []) {
      const match = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(attachment.dataUrl);
      const mediaType = (attachment.mediaType || match?.[1] || "").toLowerCase();
      if (match && /;base64/i.test(match[2]) && IMAGE_TYPES.has(mediaType)) {
        parts.push({ type: "image", name: attachment.name, mediaType, data: match[3] });
      } else {
        parts.push({ type: "text", text: `(The image "${attachment.name}" could not be passed on.)` });
      }
    }
    if (turn.afterAttachments?.trim()) parts.push({ type: "text", text: turn.afterAttachments });
  }
  if (!parts.some((p) => p.type === "image" || p.text.trim())) parts.push({ type: "text", text: "(empty message)" });
  return parts;
}

// ---------- Claude Code ----------

export function claudeArgs(request: SpeakRequest): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    // Skips the host's CLAUDE.md, hooks, plugins, MCP servers and skills, and
    // keeps the subscription login. --bare would skip the login too.
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    // Nobody answers permission prompts; anything not allowed below is refused.
    "--permission-prompts", "none",
    "--max-turns", String(CLAUDE_MAX_TURNS),
  ];
  // Without a chosen model the tool runs on its own default.
  if (isToolModelId(request.toolModel)) args.push("--model", request.toolModel);
  args.push(
    // The = form keeps instructions that start with "-" from reading as a flag.
    `--system-prompt=${request.instructions.trim() || "Answer the user's message."}`,
  );
  if (request.browsing) args.push("--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch");
  else args.push("--tools", "");
  return args;
}

export function claudeInput(parts: PromptPart[]): string {
  const content = parts.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } },
  );
  const message = { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
  return `${JSON.stringify(message)}\n`;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface Translator {
  line(line: string): SpeakEvent[];
  finish(exit: ExitInfo, durationMs: number): SpeakEvent;
}

// Keeps text blocks apart: a block that starts after earlier text begins on
// a new paragraph.
class TextJoiner {
  private tail = "";
  private newBlock = false;
  sent = false;

  startBlock(): void {
    if (this.sent) this.newBlock = true;
  }

  push(text: string): SpeakEvent[] {
    if (!text) return [];
    let delta = text;
    if (this.newBlock) {
      this.newBlock = false;
      const gap = this.tail.endsWith("\n\n") ? "" : this.tail.endsWith("\n") ? "\n" : "\n\n";
      delta = gap + delta.replace(/^\n+/, "");
    }
    this.tail = (this.tail + delta).slice(-2);
    this.sent = true;
    return [{ type: "text", delta }];
  }
}

const CLAUDE_TOOLS: Record<string, ToolName> = { WebSearch: "web_search", WebFetch: "read_page" };

export class ClaudeTranslator implements Translator {
  private text = new TextJoiner();
  private currentMessage: string | null = null;
  private streamed = new Set<string>(); // messages whose text arrived as deltas
  private tools = new Map<string, ToolName>();
  private stopReason: string | null = null;
  private result: Json | null = null;
  private unreadable: string | null = null;

  constructor(private onModel?: (model: string) => void) {}

  line(line: string): SpeakEvent[] {
    let data: Json | null;
    try {
      data = asRecord(JSON.parse(line));
    } catch {
      data = null;
    }
    if (!data) {
      this.unreadable ??= line;
      return [];
    }
    // Lines from a subagent carry the id of the tool call that started it.
    if (data.parent_tool_use_id) return [];

    switch (data.type) {
      case "system":
        if (data.subtype === "init" && str(data.model)) this.onModel?.(data.model as string);
        return [];
      case "stream_event":
        return this.streamEvent(asRecord(data.event));
      case "assistant":
        return this.assistant(asRecord(data.message));
      case "user":
        return this.toolResults(asRecord(data.message));
      case "result":
        this.result = data;
        return [];
      default:
        return [];
    }
  }

  private streamEvent(event: Json | null): SpeakEvent[] {
    if (!event) return [];
    switch (event.type) {
      case "message_start":
        this.currentMessage = str(asRecord(event.message)?.id);
        return [];
      case "content_block_start":
        if (asRecord(event.content_block)?.type === "text") this.text.startBlock();
        return [];
      case "content_block_delta": {
        const delta = asRecord(event.delta);
        if (delta?.type !== "text_delta") return [];
        if (this.currentMessage) this.streamed.add(this.currentMessage);
        return this.text.push(str(delta.text) ?? "");
      }
      case "message_delta": {
        const reason = str(asRecord(event.delta)?.stop_reason);
        if (reason) this.stopReason = reason;
        return [];
      }
      default:
        return [];
    }
  }

  // Complete messages. Tool calls are read here, where their input is whole.
  // Text is read here only when it did not arrive as deltas.
  private assistant(message: Json | null): SpeakEvent[] {
    if (!message || !Array.isArray(message.content)) return [];
    const id = str(message.id);
    const events: SpeakEvent[] = [];
    for (const raw of message.content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === "text" && !(id && this.streamed.has(id))) {
        this.text.startBlock();
        events.push(...this.text.push(str(block.text) ?? ""));
      }
      if (block.type === "tool_use") {
        const callId = str(block.id);
        const tool = CLAUDE_TOOLS[str(block.name) ?? ""];
        if (!callId || !tool || this.tools.has(callId)) continue;
        this.tools.set(callId, tool);
        const input = asRecord(block.input) ?? {};
        events.push({ type: "tool-start", id: callId, tool, label: toolLabel(tool, input) });
      }
    }
    return events;
  }

  private toolResults(message: Json | null): SpeakEvent[] {
    if (!message || !Array.isArray(message.content)) return [];
    const events: SpeakEvent[] = [];
    for (const raw of message.content) {
      const block = asRecord(raw);
      const callId = str(block?.tool_use_id);
      if (!block || block.type !== "tool_result" || !callId) continue;
      const tool = this.tools.get(callId);
      if (!tool) continue;
      this.tools.delete(callId);
      const text = toolResultText(block.content);
      if (block.is_error === true) {
        events.push({ type: "tool-end", id: callId, ok: false, detail: clip(text.replace(/<\/?tool_use_error>/g, "")) || "The tool failed." });
      } else {
        events.push({ type: "tool-end", id: callId, ok: true, detail: tool === "web_search" ? countResults(text) : undefined });
      }
    }
    return events;
  }

  finish(exit: ExitInfo, durationMs: number): SpeakEvent {
    const result = this.result;
    if (!result) return processFailure("Claude Code", exit, this.unreadable);

    const usage = claudeUsage(asRecord(result.usage));
    const subtype = str(result.subtype);
    if (subtype === "error_max_turns") {
      if (this.text.sent) return { type: "done", usage, durationMs, finishReason: "max-turns" };
      return {
        type: "error",
        message: `Claude Code used all ${CLAUDE_MAX_TURNS} of its turns before it finished an answer. Try again, or turn browsing off for this agent.`,
      };
    }
    if (result.is_error === true || (subtype && subtype !== "success")) {
      return { type: "error", message: claudeErrorMessage(result) };
    }
    const reason = str(result.stop_reason) ?? this.stopReason;
    return { type: "done", usage, durationMs, finishReason: finishReasonOf(reason) };
  }
}

function claudeUsage(usage: Json | null): Usage {
  if (!usage) return {};
  const input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .map((key) => num(usage[key]))
    .filter((n): n is number => n !== undefined);
  return {
    inputTokens: input.length > 0 ? input.reduce((a, b) => a + b, 0) : undefined,
    outputTokens: num(usage.output_tokens),
  };
}

function finishReasonOf(stopReason: string | null): string {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-calls";
    case null:
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      return stopReason;
  }
}

function claudeErrorMessage(result: Json): string {
  const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === "string") : [];
  const detail = (str(result.result) || errors.join(" ")).trim();
  if (/not logged in|\/login|invalid api key|oauth token/i.test(detail)) {
    return "Claude Code is not signed in. Run claude in a terminal and sign in with /login, then try again.";
  }
  return detail ? `Claude Code could not answer. ${detail}` : "Claude Code could not answer, and gave no reason.";
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => str(asRecord(item)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

// Claude Code's search results include a JSON list of links.
function countResults(text: string): string | undefined {
  const match = /Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/.exec(text);
  if (!match) return undefined;
  try {
    const links = JSON.parse(match[1]) as unknown[];
    if (!Array.isArray(links)) return undefined;
    return links.length === 1 ? "1 result" : `${links.length} results`;
  } catch {
    return undefined;
  }
}

// ---------- Codex ----------

const CODEX_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Features that reach outside the conversation. Codex refuses names it does
// not know as --disable flags, so these are set as config values instead.
const CODEX_FEATURES_OFF = ["shell_tool", "unified_exec", "computer_use", "browser_use", "apps", "plugins"];

export interface CodexImage {
  file: string;
  name: string;
}

async function writeImages(parts: PromptPart[], dir: string): Promise<CodexImage[]> {
  const images: CodexImage[] = [];
  for (const part of parts) {
    if (part.type !== "image") continue;
    const file = path.join(dir, `image-${images.length + 1}.${CODEX_EXTENSIONS[part.mediaType] ?? "png"}`);
    await writeFile(file, Buffer.from(part.data, "base64"));
    images.push({ file, name: part.name });
  }
  return images;
}

export function codexArgs(request: SpeakRequest, { dir, images, config }: { dir: string; images: CodexImage[]; config: string }): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox", "read-only",
    "--color", "never",
    "-C", dir,
  ];
  // Without a chosen model the tool runs on its own default.
  if (isToolModelId(request.toolModel)) args.push("-m", request.toolModel);
  args.push(
    "-c", 'approval_policy="never"',
    "-c", request.browsing ? 'web_search="live"' : 'web_search="disabled"',
  );
  for (const feature of CODEX_FEATURES_OFF) args.push("-c", `features.${feature}=false`);
  for (const server of codexMcpServerNames(config)) args.push("-c", `mcp_servers.${tomlKey(server)}.enabled=false`);
  // The images come last, because -i takes every value that follows it.
  for (const image of images) args.push("-i", image.file);
  return args;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

// Codex has no system prompt option, so the instructions come first.
export function codexPrompt(instructions: string, parts: PromptPart[]): string {
  const sections: string[] = [];
  if (instructions.trim()) sections.push(`# Instructions\n\n${instructions.trim()}`);
  let n = 0;
  const body = parts
    .map((part) => (part.type === "text" ? part.text : `(Image ${++n} is attached: ${part.name})`))
    .join("\n\n");
  sections.push(`# Conversation\n\n${body}`);
  return `${sections.join("\n\n")}\n`;
}

export class CodexTranslator implements Translator {
  private text = new TextJoiner();
  private started = new Set<string>();
  private usage: Usage = {};
  private completed = false;
  private failure: string | null = null;
  private lastError: string | null = null;
  private unreadable: string | null = null;

  line(line: string): SpeakEvent[] {
    let data: Json | null;
    try {
      data = asRecord(JSON.parse(line));
    } catch {
      data = null;
    }
    if (!data) {
      this.unreadable ??= line;
      return [];
    }
    switch (data.type) {
      case "item.started":
        return this.itemStarted(asRecord(data.item));
      case "item.completed":
        return this.itemCompleted(asRecord(data.item));
      case "turn.completed": {
        const usage = asRecord(data.usage);
        this.usage = { inputTokens: num(usage?.input_tokens), outputTokens: num(usage?.output_tokens) };
        this.completed = true;
        return [];
      }
      case "turn.failed":
        this.failure = str(asRecord(data.error)?.message) || "The turn failed.";
        return [];
      case "error":
        this.lastError = str(data.message) || this.lastError;
        return [];
      default:
        return [];
    }
  }

  private itemStarted(item: Json | null): SpeakEvent[] {
    if (item?.type !== "web_search") return [];
    const search = codexSearch(item);
    const id = str(item.id);
    // Without a query or URL yet, the search is shown when it completes.
    if (!id || !search.known) return [];
    this.started.add(id);
    return [{ type: "tool-start", id, tool: search.tool, label: search.label }];
  }

  private itemCompleted(item: Json | null): SpeakEvent[] {
    if (!item) return [];
    if (item.type === "agent_message") {
      this.text.startBlock();
      return this.text.push(str(item.text) ?? "");
    }
    if (item.type === "web_search") {
      const id = str(item.id);
      if (!id) return [];
      const events: SpeakEvent[] = [];
      if (!this.started.has(id)) {
        const search = codexSearch(item);
        events.push({ type: "tool-start", id, tool: search.tool, label: search.label });
      }
      this.started.delete(id);
      events.push({ type: "tool-end", id, ok: true });
      return events;
    }
    return [];
  }

  finish(exit: ExitInfo, durationMs: number): SpeakEvent {
    if (this.failure) return { type: "error", message: `Codex could not answer. ${this.failure}` };
    if (this.completed) return { type: "done", usage: this.usage, durationMs, finishReason: "stop" };
    return processFailure("Codex", exit, this.unreadable, this.lastError);
  }
}

function codexSearch(item: Json): { tool: ToolName; label: string; known: boolean } {
  const action = asRecord(item.action);
  const url = str(action?.url);
  if (url && (action?.type === "open_page" || action?.type === "find_in_page")) {
    return { tool: "read_page", label: toolLabel("read_page", { url }), known: true };
  }
  const queries = Array.isArray(action?.queries) ? action.queries : [];
  const query = str(item.query) || str(action?.query) || queries.find((q): q is string => typeof q === "string") || "";
  return { tool: "web_search", label: toolLabel("web_search", { query }), known: query.trim() !== "" };
}

// ---------- Running the process ----------

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null; // the process could not be started
  stderr: string; // the last few thousand characters
}

interface RunSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  signal: AbortSignal;
  spawnFn: SpawnFn;
}

// Yields each line the process writes to stdout, then returns how it ended.
// The process is stopped when the signal aborts or the reader stops early.
export async function* runLines(spec: RunSpec): AsyncGenerator<string, ExitInfo> {
  const child = spec.spawnFn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });

  const exited = new Promise<ExitInfo>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error, stderr }));
    child.once("close", (code, signal) => resolve({ code, signal, error: null, stderr }));
  });

  const stop = () => stopChild(child);
  if (spec.signal.aborted) stop();
  else spec.signal.addEventListener("abort", stop, { once: true });

  // The tool may exit before it reads everything; that shows up in its exit.
  child.stdin?.on("error", () => {});
  child.stdin?.end(spec.stdin);

  const reader = child.stdout ? createInterface({ input: child.stdout, crlfDelay: Infinity }) : null;
  try {
    if (reader) {
      for await (const line of reader) {
        if (line.trim()) yield line;
      }
    }
    const info = await exited;
    return { ...info, stderr };
  } finally {
    spec.signal.removeEventListener("abort", stop);
    reader?.close();
    if (child.exitCode === null && child.signalCode === null) stop();
  }
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  timer.unref?.();
}

// The child gets this server's environment, minus API keys, so the call
// runs on the subscription the tool is signed in with, and minus the
// variables that mark a process as running inside Claude Code.
const REMOVED_ENV = ["ANTHROPIC_API_KEY", "CODEX_API_KEY", "AI_GATEWAY_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const key of REMOVED_ENV) delete env[key];
  return env;
}

// ---------- Errors ----------

function tail(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > TAIL_CHARS ? `...${single.slice(-TAIL_CHARS)}` : single;
}

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > DETAIL_LIMIT ? `${single.slice(0, DETAIL_LIMIT - 3)}...` : single;
}

// A process that ended without a result.
function processFailure(name: string, exit: ExitInfo, unreadable: string | null, lastError?: string | null): SpeakEvent {
  if (exit.error) {
    const code = (exit.error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "The command was not found." : exit.error.message;
    return { type: "error", message: `${name} could not be started. ${reason}` };
  }
  const detail = tail(lastError || exit.stderr) || (unreadable ? `It printed: ${tail(unreadable)}` : "");
  if (exit.code !== null && exit.code !== 0) {
    return { type: "error", message: `${name} exited with code ${exit.code}${detail ? `: ${detail}` : "."}` };
  }
  if (exit.signal) {
    return { type: "error", message: `${name} was stopped by ${exit.signal}${detail ? `: ${detail}` : "."}` };
  }
  if (unreadable) {
    return { type: "error", message: `${name} sent output that could not be read: ${tail(unreadable)}` };
  }
  return { type: "error", message: `${name} ended before it finished the reply.${detail ? ` ${detail}` : ""}` };
}
