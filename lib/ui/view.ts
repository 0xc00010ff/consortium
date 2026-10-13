// Values the interface derives from a Table. Pure functions, no React.

import {
  SEAT_COLORS,
  SEAT_LETTERS,
  type Arbiter,
  type ModelInfo,
  type ModelsResponse,
  type PrivateMessage,
  type Reply,
  type Round,
  type Seat,
  type SeatColor,
  type SeatId,
  type Table,
} from "@/lib/types";
import { nextSeatId } from "./engine";
import { plural } from "./format";

export const UNTITLED = "Untitled table";
export const MAX_SEATS = SEAT_LETTERS.length;

export function lastRound(table: Table): Round | undefined {
  return table.rounds[table.rounds.length - 1];
}

function messageBusy(m: PrivateMessage): boolean {
  return m.status === "queued" || m.status === "streaming";
}

// The agent or arbiter whose private reply is in progress, if any.
export function privateBusyParticipant(table: Table): string | null {
  for (const [id, thread] of Object.entries(table.privateThreads)) {
    if (thread?.some(messageBusy)) return id;
  }
  return null;
}

export function roundBusy(table: Table): boolean {
  return lastRound(table)?.status === "running";
}

export function isBusy(table: Table): boolean {
  return roundBusy(table) || privateBusyParticipant(table) !== null;
}

// ---------- participants ----------

// The seat as it was in a round, falling back to the table's current seat.
export function seatIn(round: Round | undefined, table: Table, id: string): Seat | undefined {
  return round?.seats?.find((s) => s.id === id) ?? table.seats.find((s) => s.id === id);
}

export function arbiterIn(round: Round | undefined, table: Table, id: string): Arbiter | undefined {
  return round?.arbiters?.find((a) => a.id === id) ?? table.arbiters.find((a) => a.id === id);
}

// An agent or an arbiter, with what the interface shows for it.
export interface Participant {
  id: string; // a SeatId or an arbiter id
  kind: "agent" | "arbiter";
  name: string; // the heading: an agent's name or model name, or the arbiter's name
  label: string; // how copy refers to it: "Agent B" or "Tracker"
  modelName: string;
  hostName?: string; // the host's name for an agent, when it has one
  color?: SeatColor; // agents only
}

// The agent or arbiter as it was in a round, falling back to the table's
// current participants. Without a round, only the current table counts.
export function participantIn(round: Round | undefined, table: Table, id: string): Participant | undefined {
  if (isSeatId(id)) {
    const seat = seatIn(round, table, id);
    if (!seat) return undefined;
    return {
      id,
      kind: "agent",
      name: seatDisplayName(seat),
      label: `Agent ${id}`,
      modelName: seat.modelName,
      hostName: seatName(seat),
      color: seatColor(seat),
    };
  }
  const arbiter = arbiterIn(round, table, id);
  if (!arbiter) return undefined;
  const name = arbiter.name.trim() || "Arbiter";
  return { id, kind: "arbiter", name, label: name, modelName: arbiter.modelName };
}

// The agent's color: the host's choice, or the letter's own color.
export function seatColor(seat: Pick<Seat, "id" | "color">): SeatColor {
  return seat.color ?? SEAT_COLORS[SEAT_LETTERS.indexOf(seat.id)] ?? SEAT_COLORS[0];
}

export const COLOR_LABELS: Record<SeatColor, string> = {
  blue: "Blue",
  green: "Green",
  purple: "Purple",
  orange: "Orange",
  teal: "Teal",
  pink: "Pink",
  olive: "Olive",
  brown: "Brown",
};

// The host's name for the agent, or the model name when it has none.
export function seatDisplayName(seat: Pick<Seat, "name" | "modelName">): string {
  return seat.name?.trim() || seat.modelName;
}

// The host's name for the agent, trimmed, or undefined when it has none.
export function seatName(seat: Pick<Seat, "name">): string | undefined {
  return seat.name?.trim() || undefined;
}

export function isSeatId(id: string): id is SeatId {
  return (SEAT_LETTERS as readonly string[]).includes(id);
}

// The letter for a new seat. It must be one that no earlier reply used, or
// the new seat would take over a removed seat's replies. Null when every
// letter has been used at this table.
export function freshSeatLetter(table: Table): SeatId | null {
  const id = nextSeatId(table);
  if (!id) return null;
  const used = table.rounds.some((r) => r.replies.some((x) => x.participantId === id) || r.seats?.some((s) => s.id === id));
  return used ? null : id;
}

function modelInfo(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}

// A new seat gets a default model from a maker the table does not have yet.
export function newSeat(table: Table, data: ModelsResponse): Seat | null {
  const id = freshSeatLetter(table);
  if (!id) return null;
  const used = new Set(table.seats.map((s) => s.maker));
  const defaults = data.defaults.seats.map((m) => modelInfo(data.models, m)).filter((m): m is ModelInfo => !!m);
  const pick = defaults.find((m) => !used.has(m.maker)) ?? defaults[table.seats.length % Math.max(1, defaults.length)] ?? data.models[0];
  if (!pick) return null;
  return { id, modelId: pick.id, modelName: pick.name, maker: pick.maker, browsing: true };
}

// New arbiters are "Arbiter 1", "Arbiter 2" and so on, with the default arbiter model.
export function newArbiter(table: Table, data: ModelsResponse): Arbiter | null {
  const numbers = [
    ...table.arbiters.map((a) => a.id),
    ...table.rounds.flatMap((r) => r.arbiterReplies.map((x) => x.participantId)),
  ]
    .map((id) => Number(/^arbiter-(\d+)$/.exec(id)?.[1] ?? 0))
    .filter(Number.isFinite);
  const n = Math.max(0, ...numbers) + 1;
  const model = modelInfo(data.models, data.defaults.arbiter) ?? data.models[0];
  if (!model) return null;
  return {
    id: `arbiter-${n}`,
    name: `Arbiter ${n}`,
    modelId: model.id,
    modelName: model.name,
    maker: model.maker,
    browsing: false,
    instructions: "",
  };
}

// The list with the item at index `from` moved to index `to`. The same
// objects in a new order, so reordering seats keeps their letters.
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

// The participant with a new model. A tool's model choice belongs to that
// tool, so it is cleared and the new model starts from its own default.
export function withModel<T extends Seat | Arbiter>(p: T, models: ModelInfo[], modelId: string): T {
  const m = modelInfo(models, modelId);
  if (!m) return p;
  if (m.id === p.modelId) return p;
  return { ...p, modelId: m.id, modelName: m.name, maker: m.maker, toolModel: undefined };
}

// ---------- copy ----------

// Interaction and turns as the host picks them: Independent, or a Group
// table that answers in parallel or round robin. Turns only matter in a
// Group table, and an absent turns means parallel. Works for a Table or a Round.
export type Mode = "independent" | "parallel" | "roundRobin";

export function modeOf(t: Pick<Table, "interaction" | "turns">): Mode {
  if (t.interaction === "independent") return "independent";
  return t.turns === "roundRobin" ? "roundRobin" : "parallel";
}

export const MODE_LABELS: Record<Mode, string> = {
  independent: "Independent",
  parallel: "Parallel",
  roundRobin: "Round robin",
};

export function modeLabel(t: Pick<Table, "interaction" | "turns">): string {
  return MODE_LABELS[modeOf(t)];
}

// The settings that give each mode.
export function modeEdit(mode: Mode): Pick<Table, "interaction" | "turns"> {
  if (mode === "independent") return { interaction: "independent", turns: "parallel" };
  return { interaction: "group", turns: mode };
}

// "Round robin · 4 agents · 1 arbiter · Round 2".
export function subtitle(table: Table): string {
  const parts = [modeLabel(table)];
  parts.push(plural(table.seats.length, "agent"));
  if (table.arbiters.length) parts.push(plural(table.arbiters.length, "arbiter"));
  if (table.rounds.length) parts.push(`Round ${table.rounds.length}`);
  return parts.join(" · ");
}

export function roundReplyCount(round: Round): number {
  return round.replies.length + round.arbiterReplies.length;
}

// ---------- private conversations ----------

// The messages of an agent's or arbiter's private conversation that followed a given round.
export function privateAfter(table: Table, participantId: string, round: number): PrivateMessage[] {
  return (table.privateThreads[participantId] ?? []).filter((m) => m.afterRound === round);
}

// The agent's or arbiter's most recent reply in a round, and the round it came from.
export function latestReply(table: Table, participantId: string): { round: Round; reply: Reply } | null {
  for (let i = table.rounds.length - 1; i >= 0; i--) {
    const round = table.rounds[i];
    const reply = [...round.replies, ...round.arbiterReplies].find((r) => r.participantId === participantId);
    if (reply) return { round, reply };
  }
  return null;
}
