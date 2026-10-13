// Fixtures for the engine tests: tables, a scripted SpeakFn, and helpers that
// wait for a store to reach a state.

import type {
  Arbiter,
  Interaction,
  Reply,
  Round,
  Seat,
  SeatId,
  SpeakFn,
  SpeakHandlers,
  SpeakRequest,
  SpeakResult,
  Table,
  TableStore,
} from "@/lib/types";

const NAMES: Record<string, string> = { A: "Claude Sonnet 5.5", B: "GPT-6.1 Sol", C: "Gemini 3.1 Pro", D: "Grok 4.7" };
const MAKERS = ["anthropic", "openai", "google", "xai"] as const;

export function makeSeats(count = 4): Seat[] {
  return (["A", "B", "C", "D", "E", "F", "G", "H"] as SeatId[]).slice(0, count).map((id, i) => ({
    id,
    modelId: `test/model-${id.toLowerCase()}`,
    modelName: NAMES[id] ?? `Model ${id}`,
    maker: MAKERS[i % 4],
    browsing: false,
  }));
}

export function makeArbiter(n = 1, overrides: Partial<Arbiter> = {}): Arbiter {
  return {
    id: `arbiter-${n}`,
    name: n === 1 ? "Tracker" : `Arbiter ${n}`,
    modelId: `test/arbiter-${n}`,
    modelName: `Arbiter Model ${n}`,
    maker: "anthropic",
    browsing: false,
    instructions: "Keep a numbered list of every idea and who supports it.",
    ...overrides,
  };
}

export function makeTable(overrides: Partial<Table> = {}): Table {
  return {
    id: "t1",
    title: "Test table",
    createdAt: Date.UTC(2026, 9, 12, 9, 30),
    updatedAt: 0,
    interaction: "group",
    seats: makeSeats(4),
    arbiters: [],
    rounds: [],
    privateThreads: {},
    ...overrides,
  };
}

export function doneReply(participantId: string, text: string, round: number): Reply {
  return { id: `r${round}-${participantId}`, participantId, text, status: "done", tools: [], durationMs: 1000 };
}

// A finished round where every seat and arbiter replied "<Seat X|name> in round N".
export function makeRound(table: Table, number: number, text: string, interaction: Interaction = table.interaction): Round {
  return {
    number,
    interaction,
    host: { text, attachments: [], createdAt: 0 },
    replies: table.seats.map((s) => doneReply(s.id, `Agent ${s.id} reply in round ${number}.`, number)),
    arbiterReplies: table.arbiters.map((a) => doneReply(a.id, `${a.name} reply in round ${number}.`, number)),
    status: "done",
    seats: table.seats,
    arbiters: table.arbiters,
  };
}

export interface Call {
  request: SpeakRequest;
  handlers: SpeakHandlers;
  signal: AbortSignal;
  startedAt: number;
}

export type Script = (request: SpeakRequest, call: Call) => string | Promise<string>;

// A SpeakFn that answers from a script and records every call.
export function scriptedSpeak(script: Script): { speak: SpeakFn; calls: Call[] } {
  const calls: Call[] = [];
  const speak: SpeakFn = async (request, handlers, signal) => {
    const call = { request, handlers, signal, startedAt: Date.now() };
    calls.push(call);
    const text = await script(request, call);
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    handlers.onText?.(text, text);
    const result: SpeakResult = { text, tools: [], usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 1, finishReason: "stop" };
    return result;
  };
  return { speak, calls };
}

// The text of the request's user message: transcript, then the "Now" section.
export function requestText(request: SpeakRequest): string {
  return request.messages.map((m) => [m.text, m.afterAttachments ?? ""].filter(Boolean).join("\n\n")).join("\n\n");
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Rejects with an AbortError when the signal fires.
export function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new DOMException("Stopped", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

export function waitFor(store: TableStore, predicate: (t: Table) => boolean, timeoutMs = 3000): Promise<Table> {
  return new Promise((resolve, reject) => {
    if (predicate(store.getTable())) {
      resolve(store.getTable());
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the table."));
    }, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      const table = store.getTable();
      if (predicate(table)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(table);
      }
    });
  });
}

export function lastRound(table: Table): Round {
  const round = table.rounds[table.rounds.length - 1];
  if (!round) throw new Error("The table has no rounds.");
  return round;
}
