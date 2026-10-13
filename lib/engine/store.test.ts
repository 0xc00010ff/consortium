import { describe, expect, it } from "vitest";
import type { SpeakFn, Table } from "@/lib/types";
import { createTableStore } from "./store";
import {
  deferred,
  lastRound,
  makeArbiter,
  makeSeats,
  makeTable,
  requestText,
  scriptedSpeak,
  untilAborted,
  waitFor,
} from "./test-helpers";

const message = (text: string) => ({ text, attachments: [] });

// Answers "<who> says hello in round N." after a short wait.
function echo(delayMs = 5) {
  return scriptedSpeak(async (request) => {
    await new Promise((r) => setTimeout(r, delayMs));
    const who = request.mockHint?.seatId ? `Agent ${request.mockHint.seatId}` : request.mockHint?.arbiterName;
    return `${who} says hello in round ${request.mockHint?.round}.`;
  });
}

describe("a round", () => {
  it("runs every seat at once, then the arbiters one by one, in order", async () => {
    const seatsDone = deferred();
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const { speak, calls } = scriptedSpeak(async (request) => {
      const who = request.mockHint?.seatId ?? request.mockHint?.arbiterName ?? "?";
      order.push(`start ${who}`);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (request.mockHint?.purpose === "seat") {
        if (calls.length === 4) seatsDone.resolve();
        await seatsDone.promise;
      } else {
        await new Promise((r) => setTimeout(r, 5));
      }
      running -= 1;
      order.push(`end ${who}`);
      return `${who} replied.`;
    });
    const table = makeTable({ arbiters: [makeArbiter(1), makeArbiter(2)] });
    const store = createTableStore(table, speak);

    await store.sendRound(message("How should we price the app?"));

    expect(maxRunning).toBe(4);
    expect(order.slice(0, 4)).toEqual(["start A", "start B", "start C", "start D"]);
    expect(order.slice(-4)).toEqual(["start Tracker", "end Tracker", "start Arbiter 2", "end Arbiter 2"]);
    const round = lastRound(store.getTable());
    expect(round.status).toBe("done");
    expect(round.number).toBe(1);
    expect(round.interaction).toBe("group");
    expect(round.host.text).toBe("How should we price the app?");
    expect(round.replies.map((r) => [r.participantId, r.status, r.text])).toEqual([
      ["A", "done", "A replied."],
      ["B", "done", "B replied."],
      ["C", "done", "C replied."],
      ["D", "done", "D replied."],
    ]);
    expect(round.arbiterReplies.map((r) => r.text)).toEqual(["Tracker replied.", "Arbiter 2 replied."]);
    expect(round.seats?.map((s) => s.id)).toEqual(["A", "B", "C", "D"]);
    expect(round.arbiters?.map((a) => a.name)).toEqual(["Tracker", "Arbiter 2"]);
    expect(store.isBusy()).toBe(false);

    // The second arbiter read the seats and the first arbiter from this round.
    const second = requestText(calls[5].request);
    expect(second).toContain("### Agent A\n\nA replied.");
    expect(second).toContain("### Tracker (arbiter)\n\nTracker replied.");
  });

  it("builds every seat's request before any seat replies", async () => {
    const { speak, calls } = echo(1);
    const store = createTableStore(makeTable(), speak);
    await store.sendRound(message("First"));
    await store.sendRound(message("Second"));
    const round2 = calls.slice(4, 8).map((c) => requestText(c.request));
    for (const text of round2) {
      expect(text).toContain("says hello in round 1.");
      expect(text).not.toContain("says hello in round 2.");
    }
  });

  it("sets the title from the first message unless the host has named the table", async () => {
    const { speak } = echo(1);
    const store = createTableStore(makeTable({ title: "Untitled conversation" }), speak);
    await store.sendRound(message("Pricing ideas for Habitly. We need a plan."));
    expect(store.getTable().title).toBe("Pricing ideas for Habitly");
    await store.sendRound(message("Something else entirely"));
    expect(store.getTable().title).toBe("Pricing ideas for Habitly");

    const named = createTableStore(makeTable({ title: "My table" }), speak);
    await named.sendRound(message("Pricing ideas"));
    expect(named.getTable().title).toBe("My table");
  });

  it("publishes a new Table object after every change and is busy while running", async () => {
    const { speak } = echo(1);
    const store = createTableStore(makeTable(), speak);
    const seen: Table[] = [];
    const busy: boolean[] = [];
    store.subscribe(() => {
      seen.push(store.getTable());
      busy.push(store.isBusy());
    });
    const before = store.getTable();
    const pending = store.sendRound(message("Hello"));
    expect(store.isBusy()).toBe(true);
    await expect(store.sendRound(message("Again"))).rejects.toThrow("The conversation is busy");
    await pending;
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(before);
    expect(busy[0]).toBe(true);
    expect(busy[busy.length - 1]).toBe(false);
    expect(store.getTable()).toBe(seen[seen.length - 1]);
  });

  it("throttles streaming text to about every 50 ms", async () => {
    const speak: SpeakFn = async (_request, handlers) => {
      let text = "";
      for (let i = 0; i < 40; i++) {
        text += `word${i} `;
        handlers.onText?.(`word${i} `, text);
        await new Promise((r) => setTimeout(r, 2));
      }
      return { text, tools: [], usage: {}, durationMs: 80 };
    };
    const store = createTableStore(makeTable({ seats: makeSeats(1) }), speak);
    const texts: string[] = [];
    store.subscribe(() => texts.push(lastRound(store.getTable()).replies[0].text));
    await store.sendRound(message("Go"));
    const streamed = texts.filter((t, i) => t && t !== texts[i - 1]);
    expect(streamed.length).toBeGreaterThan(1);
    expect(streamed.length).toBeLessThan(10);
    expect(lastRound(store.getTable()).replies[0].text).toContain("word39");
  });

  it("keeps going when a seat fails, and marks only that reply as an error", async () => {
    const { speak, calls } = scriptedSpeak((request) => {
      if (request.mockHint?.seatId === "B") throw new Error("The AI Gateway is limiting requests right now. Wait a minute and try again.");
      return `${request.mockHint?.seatId ?? request.mockHint?.arbiterName} is fine.`;
    });
    const store = createTableStore(makeTable({ arbiters: [makeArbiter(1)] }), speak);
    await store.sendRound(message("Hello"));
    const round = lastRound(store.getTable());
    expect(round.status).toBe("done");
    expect(round.replies.map((r) => r.status)).toEqual(["done", "error", "done", "done"]);
    expect(round.replies[1].error).toBe("The AI Gateway is limiting requests right now. Wait a minute and try again.");
    expect(round.arbiterReplies[0].status).toBe("done");
    const arbiterText = requestText(calls[4].request);
    expect(arbiterText).toContain("### Agent A");
    expect(arbiterText).not.toContain("### Agent B");
  });

  it("marks an empty reply as an error", async () => {
    const { speak } = scriptedSpeak(() => "  ");
    const store = createTableStore(makeTable({ seats: makeSeats(1) }), speak);
    await store.sendRound(message("Hello"));
    const reply = lastRound(store.getTable()).replies[0];
    expect(reply.status).toBe("error");
    expect(reply.error).toBe("The model returned an empty reply. Try again, or choose a different model.");
  });
});

describe("stop", () => {
  it("keeps partial text, marks the round stopped, and the next round can start", async () => {
    const speak: SpeakFn = async (request, handlers, signal) => {
      if (request.mockHint?.round === 1) {
        handlers.onText?.("Partial text", "Partial text");
        handlers.onTools?.([{ id: "t1", tool: "web_search", label: "prices", status: "running" }]);
        return untilAborted(signal);
      }
      return { text: "Round 2 reply.", tools: [], usage: {}, durationMs: 1 };
    };
    const table = makeTable({ seats: makeSeats(2), arbiters: [makeArbiter(1)] });
    const store = createTableStore(table, speak);

    const pending = store.sendRound(message("Start"));
    await waitFor(store, (t) => lastRound(t).replies.every((r) => r.status === "streaming"));
    store.stop();
    expect(store.isBusy()).toBe(false);
    await pending;

    const stopped = lastRound(store.getTable());
    expect(stopped.status).toBe("stopped");
    for (const reply of stopped.replies) {
      expect(reply.status).toBe("error");
      expect(reply.error).toBe("Stopped");
      expect(reply.text).toBe("Partial text");
      expect(reply.durationMs).toBeGreaterThanOrEqual(0);
      expect(reply.tools).toEqual([{ id: "t1", tool: "web_search", label: "prices", status: "error", detail: "Stopped" }]);
    }
    expect(stopped.arbiterReplies[0]).toMatchObject({ status: "error", error: "Stopped", text: "" });

    await store.sendRound(message("Again"));
    const next = lastRound(store.getTable());
    expect(next.number).toBe(2);
    expect(next.status).toBe("done");
    expect(next.replies.every((r) => r.text === "Round 2 reply.")).toBe(true);
    expect(store.getTable().rounds[0].status).toBe("stopped");
  });

  it("aborts the model calls", async () => {
    const signals: AbortSignal[] = [];
    const speak: SpeakFn = (_request, _handlers, signal) => {
      signals.push(signal);
      return untilAborted(signal);
    };
    const store = createTableStore(makeTable(), speak);
    const pending = store.sendRound(message("Start"));
    await waitFor(store, () => signals.length === 4);
    store.stop();
    await pending;
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("stops a private reply and keeps its text", async () => {
    const speak: SpeakFn = async (_request, handlers, signal) => {
      handlers.onText?.("Half an answer", "Half an answer");
      return untilAborted(signal);
    };
    const store = createTableStore(makeTable(), speak);
    const pending = store.sendPrivate("B", message("A question"));
    await new Promise((r) => setTimeout(r, 80));
    store.stop();
    await pending;
    const thread = store.getTable().privateThreads.B ?? [];
    expect(thread[1]).toMatchObject({ role: "seat", status: "error", error: "Stopped", text: "Half an answer" });
  });

  it("stops an arbiter's private reply and keeps its text", async () => {
    const signals: AbortSignal[] = [];
    const speak: SpeakFn = async (_request, handlers, signal) => {
      signals.push(signal);
      handlers.onText?.("Half a summary", "Half a summary");
      return untilAborted(signal);
    };
    const store = createTableStore(makeTable({ arbiters: [makeArbiter(1)] }), speak);
    const pending = store.sendPrivate("arbiter-1", message("A question"));
    await new Promise((r) => setTimeout(r, 80));
    store.stop();
    await pending;
    expect(store.isBusy()).toBe(false);
    expect(signals.every((s) => s.aborted)).toBe(true);
    const thread = store.getTable().privateThreads["arbiter-1"] ?? [];
    expect(thread[1]).toMatchObject({ role: "seat", status: "error", error: "Stopped", text: "Half a summary" });
  });

  it("marks a table that was saved while running as stopped", () => {
    const table = makeTable({ seats: makeSeats(1) });
    table.rounds = [
      {
        number: 1,
        interaction: "group",
        host: { text: "Hi", attachments: [], createdAt: 0 },
        replies: [{ id: "r1-A", participantId: "A", text: "Some", status: "streaming", tools: [], startedAt: 1 }],
        arbiterReplies: [],
        status: "running",
      },
    ];
    const store = createTableStore(table, echo().speak);
    const round = lastRound(store.getTable());
    expect(round.status).toBe("stopped");
    expect(round.replies[0]).toMatchObject({ status: "error", error: "Stopped", text: "Some" });
    // The real end of the reply is unknown, so it gets no duration.
    expect(round.replies[0].durationMs).toBeUndefined();
    expect(store.isBusy()).toBe(false);
  });
});

describe("private conversations", () => {
  it("adds the host message and streams the seat's reply after the last round", async () => {
    const { speak, calls } = echo(1);
    const store = createTableStore(makeTable(), speak);
    await store.sendRound(message("Start"));
    await store.sendPrivate("B", message("Why that?"));
    await store.sendPrivate("B", message("And then?"));

    const thread = store.getTable().privateThreads.B ?? [];
    expect(thread.map((m) => [m.role, m.status, m.afterRound])).toEqual([
      ["host", "done", 1],
      ["seat", "done", 1],
      ["host", "done", 1],
      ["seat", "done", 1],
    ]);
    expect(thread[3].text).toBe("Agent B says hello in round 1.");
    const last = calls[calls.length - 1].request;
    expect(last.mockHint?.purpose).toBe("private");
    expect(requestText(last)).toContain("**Host:** Why that?\n\n**You:** Agent B says hello in round 1.\n\n**Host:** And then?");
  });

  it("is carried into the next round for that seat only", async () => {
    const { speak, calls } = echo(1);
    const store = createTableStore(makeTable(), speak);
    await store.sendRound(message("Start"));
    await store.sendPrivate("C", message("Just between us"));
    const before = calls.length;
    await store.sendRound(message("Next"));
    const round2 = calls.slice(before, before + 4);
    for (const call of round2) {
      const text = requestText(call.request);
      if (call.request.mockHint?.seatId === "C") expect(text).toContain("**Host:** Just between us");
      else expect(text).not.toContain("Just between us");
    }
  });

  it("refuses a seat that is not at the table", async () => {
    const store = createTableStore(makeTable({ seats: makeSeats(2) }), echo().speak);
    await expect(store.sendPrivate("D", message("Hi"))).rejects.toThrow("Agent D is not at this table.");
  });

  it("works with an arbiter, which streams its reply into its own thread", async () => {
    const { speak, calls } = echo(1);
    const store = createTableStore(makeTable({ seats: makeSeats(2), arbiters: [makeArbiter(1)] }), speak);
    await store.sendRound(message("Start"));
    await store.sendPrivate("arbiter-1", message("Who is ahead?"));
    await store.sendPrivate("arbiter-1", message("And B?"));

    const table = store.getTable();
    const thread = table.privateThreads["arbiter-1"] ?? [];
    expect(thread.map((m) => [m.role, m.status, m.afterRound])).toEqual([
      ["host", "done", 1],
      ["seat", "done", 1],
      ["host", "done", 1],
      ["seat", "done", 1],
    ]);
    expect(thread[1].text).toBe("Tracker says hello in round 1.");
    expect(Object.keys(table.privateThreads)).toEqual(["arbiter-1"]);
    const last = calls[calls.length - 1].request;
    expect(last.modelId).toBe("test/arbiter-1");
    expect(last.mockHint).toEqual({ purpose: "private", interaction: "group", round: 1, arbiterName: "Tracker" });
    expect(requestText(last)).toContain("**Host:** Who is ahead?\n\n**You:** Tracker says hello in round 1.\n\n**Host:** And B?");
  });

  it("refuses an arbiter that is not at the table", async () => {
    const store = createTableStore(makeTable({ arbiters: [makeArbiter(1)] }), echo().speak);
    await expect(store.sendPrivate("arbiter-2", message("Hi"))).rejects.toThrow("The arbiter arbiter-2 is not at this table.");
    expect(store.isBusy()).toBe(false);
    expect(store.getTable().privateThreads).toEqual({});
  });

  it("with an arbiter is carried into that arbiter's next round only", async () => {
    const { speak, calls } = echo(1);
    const store = createTableStore(makeTable({ seats: makeSeats(2), arbiters: [makeArbiter(1), makeArbiter(2)] }), speak);
    await store.sendRound(message("Start"));
    await store.sendPrivate("arbiter-2", message("Just between us"));
    const before = calls.length;
    await store.sendRound(message("Next"));
    const round2 = calls.slice(before);
    expect(round2).toHaveLength(4);
    for (const call of round2) {
      const text = requestText(call.request);
      if (call.request.mockHint?.arbiterName === "Arbiter 2") expect(text).toContain("**Host:** Just between us");
      else expect(text).not.toContain("Just between us");
    }
  });
});

describe("edits", () => {
  it("are refused while busy and apply from the next round", async () => {
    const gate = deferred();
    const { speak, calls } = scriptedSpeak(async (request) => {
      if (request.mockHint?.round === 1) await gate.promise;
      return `${request.mockHint?.seatId ?? request.mockHint?.arbiterName} replied.`;
    });
    const store = createTableStore(makeTable(), speak);
    const pending = store.sendRound(message("Start"));
    await waitFor(store, (t) => lastRound(t).replies.every((r) => r.status === "streaming"));

    store.edit({ interaction: "independent", title: "Changed", arbiters: [makeArbiter(1)] });
    expect(store.getTable().interaction).toBe("group");
    expect(store.getTable().title).toBe("Test table");
    expect(store.getTable().arbiters).toEqual([]);

    gate.resolve();
    await pending;
    expect(lastRound(store.getTable()).arbiterReplies).toEqual([]);

    store.edit({ interaction: "independent", arbiters: [makeArbiter(1)] });
    expect(store.getTable().interaction).toBe("independent");
    expect(store.getTable().rounds[0].interaction).toBe("group");

    await store.sendRound(message("Next"));
    const round2 = lastRound(store.getTable());
    expect(round2.interaction).toBe("independent");
    expect(round2.arbiterReplies.map((r) => r.text)).toEqual(["Tracker replied."]);
    const seatB = requestText(calls[5].request);
    expect(calls[5].request.mockHint).toMatchObject({ seatId: "B", round: 2, interaction: "independent" });
    expect(seatB).toContain("### Agent B (you)");
    expect(seatB).not.toContain("### Agent A");
  });

  it("gives a new seat the next free letter and keeps a removed seat's old replies", async () => {
    const { speak } = echo(1);
    const store = createTableStore(makeTable(), speak);
    await store.sendRound(message("Start"));
    const [a, b, , d] = store.getTable().seats;
    const added = { ...a, id: "A" as const, modelName: "Another model" };
    store.edit({ seats: [a, b, d, added] });
    expect(store.getTable().seats.map((s) => s.id)).toEqual(["A", "B", "D", "E"]);

    await store.sendRound(message("Next"));
    const table = store.getTable();
    expect(table.rounds[0].replies.map((r) => r.participantId)).toEqual(["A", "B", "C", "D"]);
    expect(lastRound(table).replies.map((r) => r.participantId)).toEqual(["A", "B", "D", "E"]);
    expect(table.rounds[0].seats?.map((s) => s.id)).toEqual(["A", "B", "C", "D"]);
  });

  it("deletes a removed seat's private thread, and keeps at least one seat", async () => {
    const { speak } = echo(1);
    const store = createTableStore(makeTable(), speak);
    await store.sendRound(message("Start"));
    await store.sendPrivate("B", message("Hello B"));
    await store.sendPrivate("C", message("Hello C"));
    const [a, , c] = store.getTable().seats;
    store.edit({ seats: [a, c] });
    expect(Object.keys(store.getTable().privateThreads)).toEqual(["C"]);

    store.edit({ seats: [] });
    expect(store.getTable().seats.map((s) => s.id)).toEqual(["A", "C"]);
    store.edit({ title: "  " });
    expect(store.getTable().title).toBe("Untitled conversation");
  });

  it("delete a removed arbiter's private thread, and keep the others", async () => {
    const { speak } = echo(1);
    const store = createTableStore(makeTable({ arbiters: [makeArbiter(1), makeArbiter(2)] }), speak);
    await store.sendRound(message("Start"));
    await store.sendPrivate("arbiter-1", message("Hello Tracker"));
    await store.sendPrivate("arbiter-2", message("Hello Arbiter 2"));
    await store.sendPrivate("B", message("Hello B"));

    // Renaming, reordering and switching off agents keeps the arbiters' threads.
    const [a, b, c] = store.getTable().seats;
    store.edit({ seats: [c, { ...b, name: "Skeptic", active: false }, a] });
    expect(Object.keys(store.getTable().privateThreads).sort()).toEqual(["B", "arbiter-1", "arbiter-2"]);

    store.edit({ arbiters: [store.getTable().arbiters[1]] });
    expect(Object.keys(store.getTable().privateThreads).sort()).toEqual(["B", "arbiter-2"]);
    store.edit({ arbiters: [] });
    expect(Object.keys(store.getTable().privateThreads)).toEqual(["B"]);
  });
});

describe("votes", () => {
  it("add and take away from a reply's votes", async () => {
    const store = createTableStore(makeTable({ arbiters: [makeArbiter(1)] }), echo(1).speak);
    await store.sendRound(message("Start"));
    store.vote("r1-B", 1);
    store.vote("r1-B", 1);
    store.vote("r1-arbiter-1", -1);
    const round = lastRound(store.getTable());
    expect(round.replies.map((r) => r.votes)).toEqual([undefined, 2, undefined, undefined]);
    expect(round.arbiterReplies[0].votes).toBe(-1);
    store.vote("r1-B", -1);
    store.vote("r1-B", -1);
    expect(lastRound(store.getTable()).replies[1].votes).toBe(0);
  });

  it("work while a round is running, and the round keeps going", async () => {
    const gate = deferred();
    const { speak } = scriptedSpeak(async (request) => {
      if (request.mockHint?.round === 2) await gate.promise;
      return `${request.mockHint?.seatId} replied.`;
    });
    const store = createTableStore(makeTable(), speak);
    await store.sendRound(message("Start"));
    const pending = store.sendRound(message("Next"));
    await waitFor(store, (t) => lastRound(t).replies.every((r) => r.status === "streaming"));
    store.vote("r1-A", 1);
    expect(store.getTable().rounds[0].replies[0].votes).toBe(1);
    expect(store.isBusy()).toBe(true);
    gate.resolve();
    await pending;
    expect(lastRound(store.getTable()).status).toBe("done");
    expect(store.getTable().rounds[0].replies[0].votes).toBe(1);
  });

  it("ignore an unknown reply and a delta of 0", async () => {
    const store = createTableStore(makeTable(), echo(1).speak);
    await store.sendRound(message("Start"));
    const before = store.getTable();
    let published = 0;
    store.subscribe(() => (published += 1));
    store.vote("r9-A", 1);
    store.vote("r1-A", 0);
    expect(published).toBe(0);
    expect(store.getTable()).toBe(before);
  });
});

describe("agents that are off", () => {
  it("sit out the round, and the round keeps them in its seats", async () => {
    const { speak, calls } = echo(1);
    const seats = makeSeats(4).map((s) => (s.id === "B" || s.id === "D" ? { ...s, active: false } : s));
    const store = createTableStore(makeTable({ seats, arbiters: [makeArbiter(1)] }), speak);
    await store.sendRound(message("Start"));

    const round = lastRound(store.getTable());
    expect(round.status).toBe("done");
    expect(round.replies.map((r) => r.participantId)).toEqual(["A", "C"]);
    expect(round.seats?.map((s) => [s.id, s.active !== false])).toEqual([
      ["A", true],
      ["B", false],
      ["C", true],
      ["D", false],
    ]);
    expect(calls.map((c) => c.request.mockHint?.seatId ?? c.request.mockHint?.arbiterName)).toEqual(["A", "C", "Tracker"]);
  });

  it("answer again once turned back on, having read the rounds they sat out", async () => {
    const { speak, calls } = echo(1);
    const seats = makeSeats(2).map((s) => (s.id === "B" ? { ...s, active: false } : s));
    const store = createTableStore(makeTable({ seats }), speak);
    await store.sendRound(message("Start"));
    store.edit({ seats: store.getTable().seats.map((s) => ({ ...s, active: true })) });
    await store.sendRound(message("Next"));

    expect(lastRound(store.getTable()).replies.map((r) => r.participantId)).toEqual(["A", "B"]);
    const seatB = requestText(calls[calls.length - 1].request);
    expect(calls[calls.length - 1].request.mockHint?.seatId).toBe("B");
    expect(seatB).toContain("### Agent A\n\nAgent A says hello in round 1.");
    expect(seatB).toContain("*Agent B sat out this round.*");
  });

  it("refuse a round when every agent is off", async () => {
    const seats = makeSeats(2).map((s) => ({ ...s, active: false }));
    const store = createTableStore(makeTable({ seats }), echo().speak);
    await expect(store.sendRound(message("Hello"))).rejects.toThrow("All agents are off. Turn one on, then try again.");
    expect(store.getTable().rounds).toEqual([]);
    expect(store.isBusy()).toBe(false);
  });

  it("can still talk privately with the host", async () => {
    const seats = makeSeats(2).map((s) => (s.id === "B" ? { ...s, active: false } : s));
    const store = createTableStore(makeTable({ seats }), echo(1).speak);
    await store.sendRound(message("Start"));
    await store.sendPrivate("B", message("Are you there?"));
    expect(store.getTable().privateThreads.B?.map((m) => [m.role, m.status])).toEqual([
      ["host", "done"],
      ["seat", "done"],
    ]);
  });
});

describe("rewind", () => {
  it("deletes the round and every round after it, with the private messages that followed them", async () => {
    const store = createTableStore(makeTable({ title: "Pricing" }), echo(1).speak);
    await store.sendRound(message("First"));
    await store.sendPrivate("B", message("After one"));
    await store.sendRound({ text: "Second", attachments: [{ id: "i1", name: "chart.png", mediaType: "image/png", dataUrl: "data:," }] });
    await store.sendPrivate("B", message("After two"));
    await store.sendPrivate("C", message("Also after two"));
    await store.sendRound(message("Third"));

    const host = store.rewind(2);
    expect(host?.text).toBe("Second");
    expect(host?.attachments.map((a) => a.name)).toEqual(["chart.png"]);
    const table = store.getTable();
    expect(table.rounds.map((r) => r.number)).toEqual([1]);
    expect(table.privateThreads.B?.map((m) => m.text)).toEqual(["After one", "Agent B says hello in round 1."]);
    expect(table.privateThreads.C).toBeUndefined();
    expect(table.title).toBe("Pricing");

    await store.sendRound(message("Second, again"));
    expect(lastRound(store.getTable())).toMatchObject({ number: 2, status: "done" });
    expect(lastRound(store.getTable()).host.text).toBe("Second, again");
  });

  it("trims an arbiter's private thread the same way", async () => {
    const store = createTableStore(makeTable({ seats: makeSeats(2), arbiters: [makeArbiter(1)] }), echo(1).speak);
    await store.sendRound(message("First"));
    await store.sendPrivate("arbiter-1", message("After one"));
    await store.sendRound(message("Second"));
    await store.sendPrivate("arbiter-1", message("After two"));

    store.rewind(2);
    expect(store.getTable().privateThreads["arbiter-1"]?.map((m) => m.text)).toEqual(["After one", "Tracker says hello in round 1."]);
    store.rewind(1);
    expect(store.getTable().privateThreads).toEqual({});
  });

  it("can take the table back to before the first round", async () => {
    const store = createTableStore(makeTable(), echo(1).speak);
    await store.sendRound(message("First"));
    await store.sendPrivate("A", message("Hello"));
    expect(store.rewind(1)?.text).toBe("First");
    expect(store.getTable().rounds).toEqual([]);
    expect(store.getTable().privateThreads).toEqual({});
  });

  it("is refused while the table is busy and for a round that does not exist", async () => {
    const gate = deferred();
    const { speak } = scriptedSpeak(async (request) => {
      if (request.mockHint?.round === 2) await gate.promise;
      return "Fine.";
    });
    const store = createTableStore(makeTable(), speak);
    await store.sendRound(message("First"));
    expect(store.rewind(0)).toBeNull();
    expect(store.rewind(2)).toBeNull();

    const pending = store.sendRound(message("Second"));
    await waitFor(store, (t) => lastRound(t).replies.every((r) => r.status === "streaming"));
    const before = store.getTable();
    expect(store.rewind(1)).toBeNull();
    expect(store.getTable()).toBe(before);
    gate.resolve();
    await pending;
    expect(store.getTable().rounds.map((r) => r.status)).toEqual(["done", "done"]);
  });
});

describe("round robin", () => {
  const who = (request: { mockHint?: { seatId?: string; arbiterName?: string } }) =>
    request.mockHint?.seatId ?? request.mockHint?.arbiterName ?? "?";

  // A table seated C, A, B, in round robin.
  function robinTable(overrides: Partial<Table> = {}): Table {
    const [a, b, c] = makeSeats(3);
    return makeTable({ seats: [c, a, b], turns: "roundRobin", ...overrides });
  }

  it("runs the agents one after another in seat order, then the arbiters", async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const { speak, calls } = scriptedSpeak(async (request) => {
      order.push(`start ${who(request)}`);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      order.push(`end ${who(request)}`);
      return `${who(request)} replied.`;
    });
    const store = createTableStore(robinTable({ arbiters: [makeArbiter(1), makeArbiter(2)] }), speak);
    await store.sendRound(message("How should we price the app?"));

    expect(maxRunning).toBe(1);
    expect(order).toEqual([
      "start C", "end C", "start A", "end A", "start B", "end B",
      "start Tracker", "end Tracker", "start Arbiter 2", "end Arbiter 2",
    ]);
    const round = lastRound(store.getTable());
    expect(round.turns).toBe("roundRobin");
    expect(round.status).toBe("done");
    expect(round.replies.map((r) => [r.participantId, r.status])).toEqual([
      ["C", "done"],
      ["A", "done"],
      ["B", "done"],
    ]);
    expect(calls).toHaveLength(5);
  });

  it("queues every reply at the start, and builds each request when that agent's turn starts", async () => {
    const gate = deferred();
    const { speak, calls } = scriptedSpeak(async (request) => {
      if (who(request) === "C" && request.mockHint?.round === 2) await gate.promise;
      return `${who(request)} replied.`;
    });
    const store = createTableStore(robinTable(), speak);
    await store.sendRound(message("First"));
    const pending = store.sendRound(message("Second"));
    const started = await waitFor(store, (t) => lastRound(t).number === 2 && lastRound(t).replies[0].status === "streaming");
    expect(lastRound(started).replies.map((r) => r.status)).toEqual(["streaming", "queued", "queued"]);
    gate.resolve();
    await pending;

    const [c, a, b] = calls.slice(3).map((call) => requestText(call.request));
    expect(c.slice(c.indexOf("## Round 2"))).toMatch(/^## Round 2\n\n### Host\n\nSecond\n\n# Now/);
    expect(c).toContain("Round 2. You answer first this round.");
    expect(a).toContain("## Round 2\n\n### Host\n\nSecond\n\n### Agent C\n\nC replied.");
    expect(a).toContain("Agent C has already replied this round.");
    expect(b).toContain("## Round 2\n\n### Host\n\nSecond\n\n### Agent C\n\nC replied.\n\n### Agent A\n\nA replied.");
    expect(b).toContain("Agents C and A have already replied this round.");
  });

  it("goes on to the next agent when one fails", async () => {
    const { speak, calls } = scriptedSpeak((request) => {
      if (who(request) === "C") throw new Error("The model is not available right now.");
      return `${who(request)} replied.`;
    });
    const store = createTableStore(robinTable({ arbiters: [makeArbiter(1)] }), speak);
    await store.sendRound(message("Hello"));
    const round = lastRound(store.getTable());
    expect(round.status).toBe("done");
    expect(round.replies.map((r) => r.status)).toEqual(["error", "done", "done"]);
    expect(calls.map((c) => who(c.request))).toEqual(["C", "A", "B", "Tracker"]);
    const a = requestText(calls[1].request);
    expect(a).not.toContain("### Agent C");
    expect(a).toContain("Round 1. It is your turn. Reply to the host's message.");
  });

  it("stops the agent that is answering and marks the rest stopped", async () => {
    const signals: AbortSignal[] = [];
    const speak: SpeakFn = async (request, handlers, signal) => {
      signals.push(signal);
      if (who(request) === "C") return { text: "C replied.", tools: [], usage: {}, durationMs: 1 };
      handlers.onText?.("Partial", "Partial");
      return untilAborted(signal);
    };
    const store = createTableStore(robinTable({ arbiters: [makeArbiter(1)] }), speak);
    const pending = store.sendRound(message("Start"));
    await waitFor(store, (t) => lastRound(t).replies[1].status === "streaming");
    store.stop();
    await pending;
    await new Promise((r) => setTimeout(r, 10));

    const round = lastRound(store.getTable());
    expect(round.status).toBe("stopped");
    expect(round.replies[0]).toMatchObject({ participantId: "C", status: "done", text: "C replied." });
    expect(round.replies[1]).toMatchObject({ participantId: "A", status: "error", error: "Stopped", text: "Partial" });
    expect(round.replies[2]).toMatchObject({ participantId: "B", status: "error", error: "Stopped", text: "" });
    expect(round.arbiterReplies[0]).toMatchObject({ status: "error", error: "Stopped" });
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(true);
    expect(store.isBusy()).toBe(false);
  });

  it("skips the agents that are off", async () => {
    const { speak, calls } = echo(1);
    const seats = robinTable().seats.map((s) => (s.id === "A" ? { ...s, active: false } : s));
    const store = createTableStore(robinTable({ seats }), speak);
    await store.sendRound(message("Start"));
    expect(calls.map((c) => who(c.request))).toEqual(["C", "B"]);
    expect(lastRound(store.getTable()).replies.map((r) => r.participantId)).toEqual(["C", "B"]);
    expect(requestText(calls[1].request)).toContain("*Agent A sits out this round.*\n\n### Agent C");
  });

  it("records parallel on a round when the table has no Turns setting, and runs the agents at once", async () => {
    const gate = deferred();
    let running = 0;
    let maxRunning = 0;
    const { speak, calls } = scriptedSpeak(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (calls.length === 3) gate.resolve();
      await gate.promise;
      running -= 1;
      return "Fine.";
    });
    const store = createTableStore(makeTable({ seats: makeSeats(3) }), speak);
    await store.sendRound(message("Start"));
    expect(lastRound(store.getTable()).turns).toBe("parallel");
    expect(maxRunning).toBe(3);
  });

  it("applies a change of Turns and of seat order from the next round", async () => {
    const { speak, calls } = echo(1);
    const store = createTableStore(makeTable({ seats: makeSeats(3) }), speak);
    await store.sendRound(message("Start"));
    const [a, b, c] = store.getTable().seats;
    store.edit({ seats: [c, a, b], turns: "roundRobin" });
    expect(store.getTable().seats.map((s) => s.id)).toEqual(["C", "A", "B"]);
    expect(store.getTable().turns).toBe("roundRobin");

    await store.sendRound(message("Next"));
    const table = store.getTable();
    expect(table.rounds.map((r) => r.turns)).toEqual(["parallel", "roundRobin"]);
    expect(table.rounds[0].replies.map((r) => r.participantId)).toEqual(["A", "B", "C"]);
    expect(lastRound(table).replies.map((r) => r.participantId)).toEqual(["C", "A", "B"]);
    expect(lastRound(table).seats?.map((s) => s.id)).toEqual(["C", "A", "B"]);
    expect(calls.slice(3).map((call) => who(call.request))).toEqual(["C", "A", "B"]);
    const last = requestText(calls[5].request);
    expect(last).toContain("## Round 2\n\n### Host\n\nNext\n\n### Agent C\n\nAgent C says hello in round 2.\n\n### Agent A\n\nAgent A says hello in round 2.");
    expect(calls[5].request.instructions).toContain("in the order C, A, B. You answer last, after Agent A.");

    store.edit({ turns: "parallel" });
    await store.sendRound(message("Third"));
    expect(lastRound(store.getTable()).turns).toBe("parallel");
  });
});
