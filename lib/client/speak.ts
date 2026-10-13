// The browser side of /api/speak. It posts a SpeakRequest, reads the
// newline-delimited JSON events, and calls the handlers as text and tool
// activity arrive.

import type { SpeakEvent, SpeakFn, SpeakResult, ToolActivity, Usage } from "@/lib/types";

const SPEAK_URL = "/api/speak";

export const speak: SpeakFn = async (request, handlers, signal) => {
  if (signal.aborted) throw abortError();

  let response: Response;
  try {
    response = await fetch(SPEAK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw abortError();
    throw new Error(
      `Could not reach the server. Check that the app is still running. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (!response.ok) throw new Error(await readErrorMessage(response));
  if (!response.body) throw new Error("The server sent an empty response.");

  let text = "";
  let tools: ToolActivity[] = [];
  let finished: { usage: Usage; durationMs: number; finishReason?: string } | null = null;

  const handle = (event: SpeakEvent) => {
    switch (event.type) {
      case "text":
        if (!event.delta) return;
        text += event.delta;
        handlers.onText?.(event.delta, text);
        return;
      case "tool-start":
        tools = [...tools, { id: event.id, tool: event.tool, label: event.label, status: "running" }];
        handlers.onTools?.(tools);
        return;
      case "tool-end":
        tools = tools.map((t) =>
          t.id === event.id ? { ...t, status: event.ok ? "done" : "error", detail: event.detail } : t,
        );
        handlers.onTools?.(tools);
        return;
      case "done":
        finished = { usage: event.usage ?? {}, durationMs: event.durationMs ?? 0, finishReason: event.finishReason };
        return;
      case "error":
        throw new Error(event.message || "The model call failed.");
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handle(parseEvent(line));
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handle(parseEvent(buffer.trim()));
  } catch (err) {
    reader.cancel().catch(() => {});
    if (signal.aborted) throw abortError();
    throw err;
  }

  if (signal.aborted) throw abortError();
  if (!finished) throw new Error("The connection closed before the reply finished. Try again.");
  const { usage, durationMs, finishReason } = finished as { usage: Usage; durationMs: number; finishReason?: string };
  const result: SpeakResult = { text, tools, usage, durationMs };
  if (finishReason) result.finishReason = finishReason;
  return result;
};

function parseEvent(line: string): SpeakEvent {
  try {
    return JSON.parse(line) as SpeakEvent;
  } catch {
    throw new Error("The server sent a reply that could not be read.");
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // fall through to the status message
  }
  return `The server returned an error (status ${response.status}).`;
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("The request was stopped.", "AbortError");
  const err = new Error("The request was stopped.");
  err.name = "AbortError";
  return err;
}
