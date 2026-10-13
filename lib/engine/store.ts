// The table store (spec sections 3 and 4). It runs in the browser, holds one
// Table, runs rounds and private replies by calling a SpeakFn, and publishes a
// new Table object after every change, so React can read it with
// useSyncExternalStore. Streaming text is published at most every 50 ms.

import type {
  Arbiter,
  Attachment,
  HostMessage,
  PrivateMessage,
  Reply,
  Round,
  Seat,
  SeatId,
  SpeakFn,
  SpeakRequest,
  SpeakResult,
  Table,
  TableEdit,
  TableStore,
} from "@/lib/types";
import { SEAT_LETTERS } from "@/lib/types";
import { buildArbiterRequest, buildPrivateRequest, buildSeatRequest } from "./context";
import {
  closeRunningTools,
  makeId,
  markInterrupted,
  MAX_SEATS,
  nextArbiterId,
  nextSeatId,
  STOPPED,
  titleFrom,
  UNTITLED,
} from "./table";

const FLUSH_MS = 50;

type Message = { text: string; attachments: Attachment[] };

// Where a streaming reply lives in the table.
type Target =
  | { kind: "seat" | "arbiter"; round: number; id: string }
  | { kind: "private"; seatId: SeatId; id: string };

// The fields the store changes on a reply or a private message.
type ReplyPatch = Partial<Pick<Reply, "text" | "status" | "tools" | "usage" | "durationMs" | "error" | "startedAt" | "finishReason">>;

// One round or one private reply in progress.
interface Job {
  cancelled: boolean;
  controllers: Set<AbortController>;
  stopped: Promise<void>;
  resolveStopped: () => void;
}

export function createTableStore(table: Table, speak: SpeakFn): TableStore {
  return new Store(table, speak);
}

class Store implements TableStore {
  private table: Table;
  private readonly listeners = new Set<() => void>();
  private job: Job | null = null;
  private readonly pending = new Map<string, { target: Target; text: string }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    table: Table,
    private readonly speak: SpeakFn,
  ) {
    // A table saved while it was running has nothing running now.
    this.table = markInterrupted(table);
  }

  // ---------- Public API (arrow functions, so they can be passed around unbound) ----------

  getTable = (): Table => this.table;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  isBusy = (): boolean => this.job !== null;

  sendRound = (message: Message): Promise<void> => {
    if (this.job) return Promise.reject(new Error("The table is busy. Wait for the current round to finish, or stop it."));
    if (this.table.seats.length === 0) return Promise.reject(new Error("The table has no agents. Add an agent, then try again."));
    if (!this.table.seats.some(isOn)) return Promise.reject(new Error("All agents are off. Turn one on, then try again."));
    const job = this.startJob();
    return Promise.race([this.runRound(job, message), job.stopped]);
  };

  sendPrivate = (seatId: SeatId, message: Message): Promise<void> => {
    if (this.job) return Promise.reject(new Error("The table is busy. Wait for it to finish, or stop it."));
    if (!this.table.seats.some((s) => s.id === seatId)) {
      return Promise.reject(new Error(`Agent ${seatId} is not at this table.`));
    }
    const job = this.startJob();
    return Promise.race([this.runPrivate(job, seatId, message), job.stopped]);
  };

  stop = (): void => {
    const job = this.job;
    if (!job) return;
    this.halt(job);
    job.resolveStopped();
  };

  edit = (edit: TableEdit): void => {
    if (this.job) return;
    this.commit((t) => applyEdit(t, edit));
  };

  vote = (replyId: string, delta: number): void => {
    if (!Number.isInteger(delta) || delta === 0) return;
    if (!this.table.rounds.some((r) => [...r.replies, ...r.arbiterReplies].some((x) => x.id === replyId))) return;
    const bump = (reply: Reply): Reply => (reply.id === replyId ? { ...reply, votes: (reply.votes ?? 0) + delta } : reply);
    this.commit((t) => ({
      ...t,
      rounds: t.rounds.map((r) => ({ ...r, replies: r.replies.map(bump), arbiterReplies: r.arbiterReplies.map(bump) })),
    }));
  };

  rewind = (roundNumber: number): HostMessage | null => {
    if (this.job) return null;
    const round = this.roundOf(roundNumber);
    if (!round) return null;
    this.commit((t) => rewindTable(t, roundNumber));
    return round.host;
  };

  // ---------- Rounds ----------

  private async runRound(job: Job, message: Message): Promise<void> {
    const now = Date.now();
    const first = this.table.rounds.length === 0;
    const number = this.table.rounds.length + 1;
    const queued = (participantId: string): Reply => ({
      id: `r${number}-${participantId}`,
      participantId,
      text: "",
      status: "queued",
      tools: [],
    });
    this.commit((t) => {
      const round: Round = {
        number,
        interaction: t.interaction,
        turns: t.turns ?? "parallel",
        host: { text: message.text, attachments: message.attachments, createdAt: now },
        replies: t.seats.filter(isOn).map((s) => queued(s.id)),
        arbiterReplies: t.arbiters.map((a) => queued(a.id)),
        status: "running",
        seats: t.seats.map((s) => ({ ...s })),
        arbiters: t.arbiters.map((a) => ({ ...a })),
      };
      const title = first && isDefaultTitle(t.title) ? titleFrom(message.text) : t.title;
      return { ...t, title, rounds: [...t.rounds, round] };
    });

    try {
      // A seat that is off sits the round out. The others answer in the
      // order of the round's seats.
      const round = this.roundOf(number);
      const seats = (round?.seats ?? []).filter(isOn);
      const seatTarget = (seat: Seat): Target => ({ kind: "seat", round: number, id: `r${number}-${seat.id}` });
      if (round?.turns === "roundRobin") {
        // One seat at a time. Each request is built when that seat's turn
        // starts, so it includes the replies given earlier in this round.
        for (const seat of seats) {
          if (job.cancelled) return;
          await this.runReply(job, seatTarget(seat), buildSeatRequest(this.table, seat.id));
        }
      } else {
        // Every seat's request is built before any seat starts, so no seat
        // sees another seat's reply from this round.
        const seatJobs = seats.map((seat) => ({ target: seatTarget(seat), request: buildSeatRequest(this.table, seat.id) }));
        await Promise.all(seatJobs.map((s) => this.runReply(job, s.target, s.request)));
      }

      // Arbiters answer one after another, each reading the replies so far.
      for (const arbiter of this.roundOf(number)?.arbiters ?? []) {
        if (job.cancelled) return;
        const target: Target = { kind: "arbiter", round: number, id: `r${number}-${arbiter.id}` };
        await this.runReply(job, target, buildArbiterRequest(this.table, arbiter.id));
      }

      if (job.cancelled) return;
      this.finishJob(job, (t) => ({
        ...t,
        rounds: t.rounds.map((r) => (r.number === number ? { ...r, status: "done" } : r)),
      }));
    } catch (err) {
      this.failJob(job);
      throw err;
    }
  }

  // ---------- Private conversations ----------

  private async runPrivate(job: Job, seatId: SeatId, message: Message): Promise<void> {
    const now = Date.now();
    const afterRound = this.table.rounds.length;
    const host: PrivateMessage = {
      id: makeId(`p-${seatId}`),
      role: "host",
      text: message.text,
      ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
      status: "done",
      tools: [],
      afterRound,
      createdAt: now,
    };
    const reply: PrivateMessage = {
      id: makeId(`p-${seatId}`),
      role: "seat",
      text: "",
      status: "queued",
      tools: [],
      afterRound,
      createdAt: now,
    };
    this.commit((t) => ({
      ...t,
      privateThreads: { ...t.privateThreads, [seatId]: [...(t.privateThreads[seatId] ?? []), host, reply] },
    }));

    try {
      const request = buildPrivateRequest(this.table, seatId);
      await this.runReply(job, { kind: "private", seatId, id: reply.id }, request);
      if (job.cancelled) return;
      this.finishJob(job);
    } catch (err) {
      this.failJob(job);
      throw err;
    }
  }

  // ---------- One model call ----------

  // Streams one reply into its place in the table. A failed call marks only
  // this reply as an error, so the round goes on without it.
  private async runReply(job: Job, target: Target, request: SpeakRequest): Promise<void> {
    if (job.cancelled) return;
    const startedAt = Date.now();
    this.patch(target, { status: "streaming", startedAt });
    const controller = new AbortController();
    job.controllers.add(controller);
    try {
      const result = await this.speak(
        request,
        {
          onText: (_delta, fullText) => {
            if (!job.cancelled) this.queueText(target, fullText);
          },
          onTools: (tools) => {
            if (!job.cancelled) this.patch(target, { tools: [...tools] });
          },
        },
        controller.signal,
      );
      if (job.cancelled) return;
      this.pending.delete(target.id);
      this.patch(target, finishedPatch(result));
    } catch (err) {
      if (job.cancelled) return;
      const error = isAbortError(err) ? STOPPED : errorMessage(err);
      this.patch(target, (reply) => ({
        status: "error",
        error,
        tools: closeRunningTools(reply.tools, error === STOPPED ? STOPPED : "Did not finish"),
        durationMs: Date.now() - startedAt,
      }));
    } finally {
      job.controllers.delete(controller);
    }
  }

  // ---------- Jobs ----------

  private startJob(): Job {
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const job: Job = { cancelled: false, controllers: new Set(), stopped, resolveStopped };
    this.job = job;
    return job;
  }

  // Ends a job with one last change. The store is no longer busy when that
  // change is published, so a listener that reads isBusy() sees the new value
  // along with a new Table object.
  private finishJob(job: Job, change: (table: Table) => Table = (t) => t): void {
    if (this.job !== job) return;
    this.job = null;
    this.commit(change);
  }

  // Aborts the job's model calls and marks whatever was running as stopped.
  // The partial text that was waiting to be published is kept.
  private halt(job: Job): void {
    job.cancelled = true;
    if (this.job === job) this.job = null;
    for (const controller of job.controllers) controller.abort();
    this.commit((t) => markInterrupted(t, Date.now()));
    this.clearTimer();
  }

  // A programming error inside a job. Whatever was running is stopped so the
  // table is not left busy, and the caller's promise rejects with the error.
  private failJob(job: Job): void {
    if (!job.cancelled) this.halt(job);
  }

  private roundOf(number: number): Round | undefined {
    return this.table.rounds.find((r) => r.number === number);
  }

  // ---------- Publishing ----------

  // Applies a change to the table (with any waiting streaming text folded in
  // first), stores the result as a new object, and notifies the listeners.
  private commit(change: (table: Table) => Table): void {
    const next = change(this.withPending(this.table));
    this.table = { ...next, updatedAt: Date.now() };
    this.emit();
  }

  private patch(target: Target, change: ReplyPatch | ((reply: Reply | PrivateMessage) => ReplyPatch)): void {
    this.commit((t) => updateTarget(t, target, change));
  }

  private queueText(target: Target, text: string): void {
    this.pending.set(target.id, { target, text });
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const next = this.withPending(this.table);
    if (next !== this.table) {
      this.table = next;
      this.emit();
    }
  }

  // Folds the waiting streaming text into the table. Only replies that are
  // still streaming take it, so a finished reply keeps its final text.
  private withPending(table: Table): Table {
    if (this.pending.size === 0) return table;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    let next = table;
    for (const { target, text } of waiting) {
      next = updateTarget(next, target, (reply) => (reply.status === "streaming" && reply.text !== text ? { text } : {}));
    }
    return next;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.error("A table listener failed.", err);
      }
    }
  }
}

// ---------- Pure helpers ----------

function updateTarget(
  table: Table,
  target: Target,
  change: ReplyPatch | ((reply: Reply | PrivateMessage) => ReplyPatch),
): Table {
  const apply = <T extends Reply | PrivateMessage>(reply: T): T => {
    const patch = typeof change === "function" ? change(reply) : change;
    return Object.keys(patch).length === 0 ? reply : { ...reply, ...patch };
  };

  if (target.kind === "private") {
    const thread = table.privateThreads[target.seatId];
    if (!thread) return table;
    let changed = false;
    const nextThread = thread.map((m) => {
      if (m.id !== target.id) return m;
      const next = apply(m);
      if (next !== m) changed = true;
      return next;
    });
    return changed ? { ...table, privateThreads: { ...table.privateThreads, [target.seatId]: nextThread } } : table;
  }

  let changed = false;
  const rounds = table.rounds.map((round) => {
    if (round.number !== target.round) return round;
    const key = target.kind === "seat" ? "replies" : "arbiterReplies";
    const list = round[key].map((r) => {
      if (r.id !== target.id) return r;
      const next = apply(r);
      if (next !== r) changed = true;
      return next;
    });
    return changed ? { ...round, [key]: list } : round;
  });
  return changed ? { ...table, rounds } : table;
}

function finishedPatch(result: SpeakResult): ReplyPatch {
  const base: ReplyPatch = {
    text: result.text,
    tools: closeRunningTools(result.tools, "Did not finish"),
    usage: result.usage,
    durationMs: result.durationMs,
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
  };
  if (result.text.trim()) return { ...base, status: "done" };
  const error =
    result.finishReason === "length"
      ? "The model used its whole length limit before it wrote a reply. Try again, or choose a different model."
      : "The model returned an empty reply. Try again, or choose a different model.";
  return { ...base, status: "error", error };
}

function isOn(seat: Seat): boolean {
  return seat.active !== false;
}

// Deletes round `roundNumber` and every round after it, and the private
// messages sent after any of those rounds. Private messages sent before round
// `roundNumber` began stay, so the agent still has them when the host sends
// that round again.
export function rewindTable(table: Table, roundNumber: number): Table {
  const privateThreads: Table["privateThreads"] = {};
  for (const [seatId, thread] of Object.entries(table.privateThreads) as Array<[SeatId, PrivateMessage[] | undefined]>) {
    const kept = (thread ?? []).filter((m) => m.afterRound < roundNumber);
    if (kept.length > 0) privateThreads[seatId] = kept;
  }
  return { ...table, rounds: table.rounds.filter((r) => r.number < roundNumber), privateThreads };
}

function isDefaultTitle(title: string): boolean {
  return !title.trim() || title.trim() === UNTITLED;
}

// Applies an edit made between rounds. Seats keep at most eight, at least
// one, and unique letters; a new seat without a free letter of its own gets
// the next free letter. A removed seat's private conversation is deleted.
export function applyEdit(table: Table, edit: TableEdit): Table {
  let next: Table = { ...table };
  if (edit.title !== undefined) next.title = edit.title.trim() || UNTITLED;
  if (edit.interaction === "group" || edit.interaction === "independent") next.interaction = edit.interaction;
  if (edit.turns === "parallel" || edit.turns === "roundRobin") next.turns = edit.turns;
  if (edit.instructions !== undefined) next.instructions = edit.instructions;

  if (edit.seats && edit.seats.length > 0) {
    const wanted = edit.seats.slice(0, MAX_SEATS);
    const isValid = (id: string) => (SEAT_LETTERS as readonly string[]).includes(id);
    const keepsLetter = wanted.map((seat, i) => isValid(seat.id) && wanted.findIndex((s) => s.id === seat.id) === i);
    const reserved = wanted.filter((_, i) => keepsLetter[i]).map((s) => s.id);
    const seats: Seat[] = [];
    wanted.forEach((seat, i) => {
      if (keepsLetter[i]) {
        seats.push(seat);
        return;
      }
      const id = nextSeatId({ seats: [], rounds: table.rounds }, [...reserved, ...seats.map((s) => s.id)]);
      if (id) seats.push({ ...seat, id });
    });
    const kept = new Set(seats.map((s) => s.id));
    const privateThreads: Table["privateThreads"] = {};
    for (const [seatId, thread] of Object.entries(table.privateThreads) as Array<[SeatId, PrivateMessage[] | undefined]>) {
      if (thread && kept.has(seatId)) privateThreads[seatId] = thread;
    }
    next = { ...next, seats, privateThreads };
  }

  if (edit.arbiters) {
    const arbiters: Arbiter[] = [];
    for (const arbiter of edit.arbiters) {
      const id = arbiter.id && !arbiters.some((a) => a.id === arbiter.id) ? arbiter.id : nextArbiterId([...arbiters, ...edit.arbiters]);
      arbiters.push({ ...arbiter, id });
    }
    next.arbiters = arbiters;
  }
  return next;
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "The model call failed. Try again.";
}
