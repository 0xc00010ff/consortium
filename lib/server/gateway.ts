// Real model calls, through the AI Gateway or directly on a provider's API.
// Turns a SpeakRequest into a streamText call and translates the stream into
// SpeakEvents. Only the model instance differs between the two routes.

import {
  isStepCount,
  RetryError,
  streamText,
  type FilePart,
  type LanguageModel,
  type ModelMessage,
  type TextPart,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import type { Attachment, ChatTurn, SpeakEvent, SpeakRequest, ToolName, Usage } from "@/lib/types";
import { browsingTools, NO_WEB_SEARCH_NOTE } from "./tools";

const MAX_STEPS = 6; // search, read, then answer
const LABEL_LIMIT = 140;

export interface StreamSpeakOptions {
  model: LanguageModel;
  request: SpeakRequest;
  signal: AbortSignal;
  // The browsing tools for this call. Without them, only the page reader is
  // offered, since web search needs a gateway key.
  tools?: ToolSet;
  service?: ModelService; // who answers, for error messages
}

export async function* streamSpeakEvents({
  model,
  request,
  signal,
  tools,
  service = GATEWAY_SERVICE,
}: StreamSpeakOptions): AsyncGenerator<SpeakEvent> {
  const started = Date.now();
  let failure: unknown = null;
  const browsing = request.browsing ? (tools ?? browsingTools(null)) : undefined;

  const result = streamText({
    model,
    instructions: withSearchNote(request.instructions, browsing) || undefined,
    messages: toModelMessages(request.messages),
    tools: browsing,
    stopWhen: isStepCount(MAX_STEPS),
    maxOutputTokens: request.maxOutputTokens,
    abortSignal: signal,
    onError: ({ error }) => {
      failure = error;
    },
  });

  yield* toSpeakEvents(result.stream, { modelId: request.modelId, signal, started, failure: () => failure, service });
}

// The table's instructions mention web search. When browsing is on without
// it, one sentence tells the model so.
export function withSearchNote(instructions: string, tools: ToolSet | undefined): string {
  if (!tools || "web_search" in tools) return instructions;
  return instructions ? `${instructions}\n\n${NO_WEB_SEARCH_NOTE}` : NO_WEB_SEARCH_NOTE;
}

export interface TranslateOptions {
  modelId: string;
  signal: AbortSignal;
  started: number;
  failure?: () => unknown; // the error reported through onError, if any
  service?: ModelService;
}

// Translates streamText parts into SpeakEvents.
export async function* toSpeakEvents(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  { modelId, signal, started, failure, service = GATEWAY_SERVICE }: TranslateOptions,
): AsyncGenerator<SpeakEvent> {
  const toolNames = new Map<string, ToolName>();
  let usage: Usage = {};
  let finishReason: string | null = null;
  let sentText = "";
  let newBlock = false;

  try {
    for await (const part of parts) {
      switch (part.type) {
        case "text-start":
          // A new text block after a tool call. Keep it apart from the earlier text.
          if (sentText) newBlock = true;
          break;
        case "text-delta": {
          if (!part.text) break;
          let delta = part.text;
          if (newBlock) {
            newBlock = false;
            const gap = sentText.endsWith("\n\n") ? "" : sentText.endsWith("\n") ? "\n" : "\n\n";
            delta = gap + delta.replace(/^\n+/, "");
          }
          sentText = (sentText + delta).slice(-2);
          yield { type: "text", delta };
          break;
        }
        case "tool-call": {
          const name = asToolName(part.toolName);
          toolNames.set(part.toolCallId, name);
          yield { type: "tool-start", id: part.toolCallId, tool: name, label: toolLabel(name, part.input) };
          break;
        }
        case "tool-result": {
          if (part.preliminary) break;
          const name = toolNames.get(part.toolCallId) ?? asToolName(part.toolName);
          const outcome = describeToolOutput(name, part.output);
          yield { type: "tool-end", id: part.toolCallId, ok: outcome.ok, detail: outcome.detail };
          break;
        }
        case "tool-error":
          yield { type: "tool-end", id: part.toolCallId, ok: false, detail: shortError(part.error) };
          break;
        case "finish":
          usage = { inputTokens: part.totalUsage.inputTokens, outputTokens: part.totalUsage.outputTokens };
          finishReason = part.finishReason;
          break;
        case "error":
          if (signal.aborted) return;
          yield { type: "error", message: describeModelError(part.error, modelId, service) };
          return;
        case "abort":
          return;
        default:
          break;
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    yield { type: "error", message: describeModelError(failure?.() ?? err, modelId, service) };
    return;
  }

  if (signal.aborted) return;
  // A stream that ended without a finish part is marked "unknown".
  yield { type: "done", usage, durationMs: Date.now() - started, finishReason: finishReason ?? "unknown" };
}

// ---------- Messages ----------

export function toModelMessages(turns: ChatTurn[]): ModelMessage[] {
  return turns.map((turn): ModelMessage => {
    if (turn.role === "assistant") return { role: "assistant", content: turn.text };
    const parts: Array<TextPart | FilePart> = [];
    if (turn.text.trim()) parts.push({ type: "text", text: turn.text });
    for (const attachment of turn.attachments ?? []) {
      const file = toFilePart(attachment);
      if (file) parts.push(file);
    }
    if (turn.afterAttachments?.trim()) parts.push({ type: "text", text: turn.afterAttachments });
    if (parts.length === 0) parts.push({ type: "text", text: "(empty message)" });
    return { role: "user", content: parts };
  });
}

function toFilePart(attachment: Attachment): FilePart | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(attachment.dataUrl);
  if (match) {
    const mediaType = attachment.mediaType || match[1] || "image/png";
    const isBase64 = /;base64/i.test(match[2]);
    const data = isBase64 ? match[3] : Buffer.from(decodeURIComponent(match[3]), "utf8").toString("base64");
    return { type: "file", mediaType, data };
  }
  try {
    return { type: "file", mediaType: attachment.mediaType || "image/png", data: new URL(attachment.dataUrl) };
  } catch {
    return null;
  }
}

// ---------- Tool activity ----------

function asToolName(name: string): ToolName {
  return name === "read_page" ? "read_page" : "web_search";
}

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > LABEL_LIMIT ? `${single.slice(0, LABEL_LIMIT - 3)}...` : single;
}

export function toolLabel(tool: ToolName, input: unknown): string {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  if (tool === "read_page") return clip(typeof record.url === "string" ? record.url : "a page");
  const queries = Array.isArray(record.search_queries) ? record.search_queries : [];
  const first = queries.find((q): q is string => typeof q === "string" && q.trim() !== "");
  if (first) return clip(first);
  if (typeof record.objective === "string" && record.objective.trim()) return clip(record.objective);
  if (typeof record.query === "string" && record.query.trim()) return clip(record.query);
  return "web search";
}

export function describeToolOutput(tool: ToolName, output: unknown): { ok: boolean; detail?: string } {
  const record = typeof output === "object" && output !== null ? (output as Record<string, unknown>) : null;
  if (!record) return { ok: true };
  if (typeof record.error === "string") {
    const message = typeof record.message === "string" ? record.message : record.error;
    return { ok: false, detail: clip(message) };
  }
  if (tool === "web_search" && Array.isArray(record.results)) {
    const n = record.results.length;
    return { ok: true, detail: n === 1 ? "1 result" : `${n} results` };
  }
  if (tool === "read_page") {
    if (typeof record.title === "string" && record.title.trim()) return { ok: true, detail: clip(record.title) };
    if (typeof record.text === "string") return { ok: true, detail: `${record.text.length} characters` };
  }
  return { ok: true };
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "The tool failed.";
  return clip(message || "The tool failed.");
}

// ---------- Errors ----------

// Who answers a call, for error messages: the AI Gateway, or a provider.
export interface ModelService {
  name: string; // "The AI Gateway" or "Anthropic"
  account: string; // "AI Gateway" or "Anthropic", as in "the Anthropic account"
  keyHint: string; // where to check the key
}

export const GATEWAY_SERVICE: ModelService = {
  name: "The AI Gateway",
  account: "AI Gateway",
  keyHint: "Check the gateway key in Settings.",
};

export function providerService(label: string): ModelService {
  return { name: label, account: label, keyHint: `Check the ${label} key in Settings.` };
}

// Turns a model, gateway or provider error into a plain message for the interface.
export function describeModelError(error: unknown, modelId: string, service: ModelService = GATEWAY_SERVICE): string {
  const inner = RetryError.isInstance(error) ? error.lastError : error;
  const e = (typeof inner === "object" && inner !== null ? inner : {}) as {
    type?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  const type = typeof e.type === "string" ? e.type : "";
  const status = typeof e.statusCode === "number" ? e.statusCode : 0;
  const message = typeof e.message === "string" ? e.message : typeof inner === "string" ? inner : "";
  const { name } = service;

  if (type === "authentication_error" || status === 401) {
    return `${name} did not accept the API key. ${service.keyHint}`;
  }
  if (type === "model_not_found" || status === 404) {
    return `${name} does not offer the model ${modelId}. Choose a different model.`;
  }
  if (type === "rate_limit_exceeded" || status === 429) {
    return `${name} is limiting requests right now. Wait a minute and try again.`;
  }
  if (status === 402 || /insufficient (funds|credit)|out of credit/i.test(message)) {
    return `The ${service.account} account has run out of credit. Add credit, then try again.`;
  }
  if (type === "forbidden" || status === 403) {
    return `${name} refused the request for ${modelId}. Check that this model is enabled for your account.`;
  }
  if (type === "internal_server_error" || status >= 500) {
    return `The provider for ${modelId} had a server error. Try again in a moment.`;
  }
  if (type === "invalid_request_error" || status === 400) {
    return `The request for ${modelId} was not accepted. ${message}`.trim();
  }
  return message ? `The call to ${modelId} failed. ${message}` : `The call to ${modelId} failed.`;
}
