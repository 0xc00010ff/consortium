// Creating tables and participants, and small helpers the store and the
// interface share.

import type {
  Arbiter,
  Maker,
  ModelInfo,
  ModelsResponse,
  PrivateMessage,
  Reply,
  Seat,
  SeatId,
  Table,
  ThreadPrivacy,
  ToolActivity,
} from "@/lib/types";
import { SEAT_LETTERS } from "@/lib/types";

export const UNTITLED = "Untitled conversation";
export const STOPPED = "Stopped";
export const MAX_SEATS = SEAT_LETTERS.length;
const DEFAULT_SEAT_COUNT = 4;
const TITLE_WORDS = 7;
const TITLE_CHARS = 60;

export function makeId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

// A new table has four seats from the model defaults, no arbiters, and Group
// interaction. When there are fewer than four default models, the list
// repeats from the start.
// Every new table starts with this arbiter. The host can rename it, change
// its instructions, or remove it.
export const SUMMARIZER_NAME = "Summarizer";
export const SUMMARIZER_INSTRUCTIONS =
  "Summarize the chat up to this point, and each Agent's most recent response, in one sentence each.";

// A new table has one agent per default model. Without defaults, it takes
// the first few models in the list.
export function newTable(defaults: ModelsResponse, models: ModelInfo[]): Table {
  const known = models.length > 0 ? models : defaults.models;
  let ids = defaults.defaults.seats.filter(Boolean).slice(0, SEAT_LETTERS.length);
  if (ids.length === 0) ids = known.slice(0, DEFAULT_SEAT_COUNT).map((m) => m.id);
  const seats: Seat[] = ids.map((id, i) => seatFor(SEAT_LETTERS[i], id, known));
  const now = Date.now();
  const table: Table = {
    id: makeId("table"),
    title: UNTITLED,
    createdAt: now,
    updatedAt: now,
    interaction: "group",
    seats,
    arbiters: [],
    rounds: [],
    privateThreads: {},
  };
  const arbiterModel = defaults.defaults.arbiter || known[0]?.id;
  if (arbiterModel) {
    table.arbiters = [
      { ...newArbiter(table, arbiterModel, known), name: SUMMARIZER_NAME, instructions: SUMMARIZER_INSTRUCTIONS },
    ];
  }
  return table;
}

// The first few words of the first message, used as the table title.
export function titleFrom(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/[#*_`>[\]]/g, "").replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  if (!line) return UNTITLED;
  const sentence = /^(.+?[.?!])(\s|$)/.exec(line)?.[1] ?? line;
  const words = sentence.split(" ");
  let title = "";
  for (const word of words.slice(0, TITLE_WORDS)) {
    const next = title ? `${title} ${word}` : word;
    if (next.length > TITLE_CHARS && title) break;
    title = next;
  }
  title = title.slice(0, TITLE_CHARS);
  const cut = title.length < sentence.length;
  title = title.replace(/[.,;:!?\s]+$/, "");
  if (sentence.endsWith("?") && !cut) title += "?";
  return cut ? `${title}…` : title;
}

// ---------- Participants ----------

export function makerOf(modelId: string): Maker {
  const prefix = modelId.split("/")[0];
  if (prefix === "openai" || prefix === "google" || prefix === "anthropic") return prefix;
  if (prefix === "xai" || prefix === "spacexai") return "xai";
  return "anthropic";
}

function modelNameOf(modelId: string, models: ModelInfo[]): string {
  return models.find((m) => m.id === modelId)?.name ?? (modelId.split("/").pop() || modelId);
}

export function seatFor(id: SeatId, modelId: string, models: ModelInfo[]): Seat {
  const info = models.find((m) => m.id === modelId);
  return {
    id,
    modelId,
    modelName: modelNameOf(modelId, models),
    maker: info?.maker ?? makerOf(modelId),
    browsing: true,
  };
}

// The next free letter for a new seat. Letters that never appeared at the
// table come first, so a new seat does not take over a removed seat's old
// replies. When all eight have been used, any letter not held by a current
// seat is used.
export function nextSeatId(table: Pick<Table, "seats" | "rounds">, taken: SeatId[] = []): SeatId | null {
  const current = new Set<string>([...table.seats.map((s) => s.id), ...taken]);
  const used = new Set<string>(current);
  for (const round of table.rounds) {
    for (const reply of round.replies) used.add(reply.participantId);
    for (const seat of round.seats ?? []) used.add(seat.id);
  }
  return SEAT_LETTERS.find((l) => !used.has(l)) ?? SEAT_LETTERS.find((l) => !current.has(l)) ?? null;
}

// A seat for "Add seat", with the next free letter. Null when the table is full.
export function newSeat(table: Table, modelId: string, models: ModelInfo[]): Seat | null {
  const id = table.seats.length < MAX_SEATS ? nextSeatId(table) : null;
  return id ? seatFor(id, modelId, models) : null;
}

// An arbiter for "Add arbiter", named "Arbiter 1", "Arbiter 2" and so on.
export function newArbiter(table: Table, modelId: string, models: ModelInfo[]): Arbiter {
  const info = models.find((m) => m.id === modelId);
  return {
    id: nextArbiterId(table.arbiters),
    name: nextArbiterName(table.arbiters),
    modelId,
    modelName: modelNameOf(modelId, models),
    maker: info?.maker ?? makerOf(modelId),
    browsing: false,
    instructions: "",
  };
}

export function nextArbiterId(arbiters: Arbiter[]): string {
  const ids = new Set(arbiters.map((a) => a.id));
  let n = 1;
  while (ids.has(`arbiter-${n}`)) n += 1;
  return `arbiter-${n}`;
}

function nextArbiterName(arbiters: Arbiter[]): string {
  const names = new Set(arbiters.map((a) => a.name));
  let n = arbiters.length + 1;
  while (names.has(`Arbiter ${n}`)) n += 1;
  return `Arbiter ${n}`;
}

// ---------- Side conversations ----------

// Who reads the host's side conversation with a participant. The store marks
// a thread shared when it starts, so a missing entry means one of two things.
// A thread that already has messages was held before this setting existed,
// and stays private. A thread with no messages yet will start shared.
export function threadPrivacy(table: Pick<Table, "privateThreads" | "threadPrivacy">, participantId: string): ThreadPrivacy {
  const set = table.threadPrivacy?.[participantId];
  if (set === "shared" || set === "private") return set;
  return (table.privateThreads[participantId]?.length ?? 0) > 0 ? "private" : "shared";
}

// ---------- Interrupted work ----------

// Tool activity cannot still be running once its reply has ended.
export function closeRunningTools(tools: ToolActivity[], detail: string): ToolActivity[] {
  if (!tools.some((t) => t.status === "running")) return tools;
  return tools.map((t) => (t.status === "running" ? { ...t, status: "error", detail } : t));
}

function stopReply<T extends Reply | PrivateMessage>(reply: T, stoppedAt?: number): T {
  if (reply.status !== "queued" && reply.status !== "streaming") return reply;
  const timed = stoppedAt !== undefined && reply.status === "streaming" && reply.startedAt;
  return {
    ...reply,
    status: "error",
    error: STOPPED,
    tools: closeRunningTools(reply.tools, STOPPED),
    ...(timed ? { durationMs: stoppedAt - (reply.startedAt ?? stoppedAt) } : {}),
  };
}

// Marks anything still running as stopped. The store uses it for Stop, with
// the time of the stop, so a reply that was streaming gets its duration. When
// it opens a table that was running when the page closed, it passes no time,
// and the durations stay unset, because the real end of those replies is
// unknown. Returns the same object when nothing was running.
export function markInterrupted(table: Table, stoppedAt?: number): Table {
  let changed = false;
  const rounds = table.rounds.map((round) => {
    const busy =
      round.status === "running" ||
      round.replies.some((r) => r.status === "queued" || r.status === "streaming") ||
      round.arbiterReplies.some((r) => r.status === "queued" || r.status === "streaming");
    if (!busy) return round;
    changed = true;
    return {
      ...round,
      status: round.status === "running" ? ("stopped" as const) : round.status,
      replies: round.replies.map((r) => stopReply(r, stoppedAt)),
      arbiterReplies: round.arbiterReplies.map((r) => stopReply(r, stoppedAt)),
    };
  });
  const privateThreads: Table["privateThreads"] = {};
  // Keyed by an agent's letter or an arbiter's id.
  for (const [participantId, thread] of Object.entries(table.privateThreads)) {
    if (!thread) continue;
    if (thread.some((m) => m.status === "queued" || m.status === "streaming")) {
      changed = true;
      privateThreads[participantId] = thread.map((m) => stopReply(m, stoppedAt));
    } else {
      privateThreads[participantId] = thread;
    }
  }
  return changed ? { ...table, rounds, privateThreads } : table;
}
