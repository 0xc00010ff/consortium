// POST /api/speak: one model call, streamed back as newline-delimited JSON
// SpeakEvents. In mock mode it writes scripted replies instead.
//
// Where a call goes:
// - CONSORTIUM_MOCK=1: scripted replies for every model id.
// - "cli/claude-code" or "cli/codex": the tool on this machine (lib/server/cli.ts).
// - Any other id: the AI Gateway with a key. Without a key, scripted replies,
//   unless Claude Code or Codex is installed. Then the list offers only those
//   tools, and a gateway id gets a plain error instead of a sample reply.

import type { SpeakEvent, SpeakRequest } from "@/lib/types";
import { cliSpeakEvents } from "@/lib/server/cli";
import { findCliTool, getCliTools, isCliModelId } from "@/lib/server/cliTools";
import { hasGatewayKey, isForcedMock } from "@/lib/server/env";
import { streamSpeakEvents } from "@/lib/server/gateway";
import { mockSpeakEvents } from "@/lib/server/mock";
import { eventsResponse } from "@/lib/server/ndjson";
import { SPEAK_TIME_LIMIT_MS, withTimeLimit } from "@/lib/server/timeLimit";
import { parseSpeakRequest } from "@/lib/server/validate";

// A seat may search, read pages and then answer, which can take a while.
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const parsed = parseSpeakRequest(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  // Stopping the table aborts the browser's request. Pass that on to the model call.
  const controller = new AbortController();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", () => controller.abort(), { once: true });

  const events = speakEvents(parsed.request, controller.signal);

  // A hung call ends after 5 minutes with a plain error.
  const limited = withTimeLimit(events, SPEAK_TIME_LIMIT_MS, () => controller.abort());
  return eventsResponse(limited, () => controller.abort());
}

function speakEvents(request: SpeakRequest, signal: AbortSignal): AsyncGenerator<SpeakEvent> {
  if (isForcedMock()) return mockSpeakEvents(request, signal);

  if (isCliModelId(request.modelId)) {
    const tool = findCliTool(request.modelId);
    if (!tool) {
      const name = request.modelId === "cli/codex" ? "Codex" : "Claude Code";
      return single(`${name} was not found on this machine. Install it, or choose a different model for this agent.`);
    }
    return cliSpeakEvents({ request, signal, tool });
  }

  if (hasGatewayKey()) return streamSpeakEvents({ model: request.modelId, request, signal });
  if (getCliTools().length > 0) {
    return single(
      `${request.modelId} runs through the AI Gateway, and no AI_GATEWAY_API_KEY is set. Choose Claude Code or Codex for this agent, or add a key to .env.local.`,
    );
  }
  return mockSpeakEvents(request, signal);
}

async function* single(message: string): AsyncGenerator<SpeakEvent> {
  yield { type: "error", message };
}
