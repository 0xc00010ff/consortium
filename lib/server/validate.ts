// Light validation of the /api/speak request body.

import type { Attachment, ChatTurn, MockHint, SeatId, SpeakRequest } from "@/lib/types";
import { SEAT_LETTERS } from "@/lib/types";
import { isToolModelId } from "./cliTools";

const MAX_OUTPUT_TOKENS_CAP = 16000;

export type ParsedSpeakRequest = { ok: true; request: SpeakRequest } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttachments(value: unknown): Attachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter(
    (a): a is Attachment =>
      isRecord(a) && typeof a.dataUrl === "string" && a.dataUrl.length > 0 && typeof a.mediaType === "string",
  );
  return list.length > 0
    ? list.map((a) => ({ id: String(a.id ?? ""), name: String(a.name ?? "image"), mediaType: a.mediaType, dataUrl: a.dataUrl }))
    : undefined;
}

export function parseSpeakRequest(body: unknown): ParsedSpeakRequest {
  if (!isRecord(body)) return { ok: false, error: "The request body must be a JSON object." };

  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  if (!modelId) return { ok: false, error: "The request is missing a model id." };

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, error: "The request needs at least one message." };
  }

  const messages: ChatTurn[] = [];
  for (const raw of body.messages) {
    if (!isRecord(raw) || (raw.role !== "user" && raw.role !== "assistant")) {
      return { ok: false, error: "Each message needs a role of user or assistant." };
    }
    const message: ChatTurn = { role: raw.role, text: typeof raw.text === "string" ? raw.text : "" };
    const attachments = raw.role === "user" ? parseAttachments(raw.attachments) : undefined;
    if (attachments) message.attachments = attachments;
    if (typeof raw.afterAttachments === "string" && raw.afterAttachments) message.afterAttachments = raw.afterAttachments;
    messages.push(message);
  }

  const request: SpeakRequest = {
    modelId,
    instructions: typeof body.instructions === "string" ? body.instructions : "",
    messages,
    browsing: body.browsing === true,
  };
  if (typeof body.maxOutputTokens === "number" && Number.isFinite(body.maxOutputTokens) && body.maxOutputTokens > 0) {
    request.maxOutputTokens = Math.min(Math.floor(body.maxOutputTokens), MAX_OUTPUT_TOKENS_CAP);
  }
  // It becomes a command line argument, so anything else is dropped.
  if (isToolModelId(body.toolModel)) request.toolModel = body.toolModel;
  const hint = parseMockHint(body.mockHint);
  if (hint) request.mockHint = hint;
  return { ok: true, request };
}

// The hint only shapes sample replies, so unknown values fall back to defaults.
function parseMockHint(value: unknown): MockHint | undefined {
  if (!isRecord(value)) return undefined;
  const hint: MockHint = {
    purpose: value.purpose === "arbiter" || value.purpose === "private" ? value.purpose : "seat",
    interaction: value.interaction === "independent" ? "independent" : "group",
    round: typeof value.round === "number" && Number.isFinite(value.round) && value.round >= 0 ? Math.floor(value.round) : 1,
  };
  if (typeof value.seatId === "string" && (SEAT_LETTERS as readonly string[]).includes(value.seatId)) {
    hint.seatId = value.seatId as SeatId;
  }
  if (typeof value.arbiterName === "string" && value.arbiterName.trim()) hint.arbiterName = value.arbiterName.trim().slice(0, 80);
  return hint;
}
