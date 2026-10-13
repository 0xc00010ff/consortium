import { describe, expect, it } from "vitest";
import type { Round, SeatId, Table } from "@/lib/types";
import { buildArbiterRequest, buildPrivateRequest, buildSeatRequest } from "@/lib/engine/context";
import { doneReply, makeArbiter, makeTable } from "@/lib/engine/test-helpers";
import { writeMockReply } from "./mock";

const TOPIC = "How should a small team plan its first product launch?";

// Plays a table forward with mock replies, the way the store would.
function playRound(table: Table, text: string): Table {
  const number = table.rounds.length + 1;
  const queued = (id: string) => ({ id: `r${number}-${id}`, participantId: id, text: "", status: "queued" as const, tools: [] });
  let round: Round = {
    number,
    interaction: table.interaction,
    host: { text, attachments: [], createdAt: 0 },
    replies: table.seats.map((s) => queued(s.id)),
    arbiterReplies: table.arbiters.map((a) => queued(a.id)),
    status: "running",
    seats: table.seats,
    arbiters: table.arbiters,
  };
  const withRound = (r: Round): Table => ({ ...table, rounds: [...table.rounds, r] });

  const replies = table.seats.map((s) => doneReply(s.id, writeMockReply(buildSeatRequest(withRound(round), s.id)).text, number));
  round = { ...round, replies };
  table.arbiters.forEach((arbiter, i) => {
    const reply = doneReply(arbiter.id, writeMockReply(buildArbiterRequest(withRound(round), arbiter.id)).text, number);
    round = { ...round, arbiterReplies: round.arbiterReplies.map((r, j) => (j === i ? reply : r)) };
  });
  return withRound({ ...round, status: "done" });
}

function seatText(table: Table, round: number, seatId: SeatId): string {
  return table.rounds[round - 1].replies.find((r) => r.participantId === seatId)?.text ?? "";
}

describe("mock seat replies", () => {
  it("are two or three paragraphs that mention the host's message, and vary by seat", () => {
    const table = playRound(makeTable(), TOPIC);
    const texts = table.seats.map((s) => seatText(table, 1, s.id));
    for (const text of texts) {
      const paragraphs = text.split("\n\n");
      expect(paragraphs.length).toBeGreaterThanOrEqual(2);
      expect(paragraphs.length).toBeLessThanOrEqual(3);
      expect(text).toContain("How should a small team plan its first product launch");
      expect(text).not.toMatch(/[—]/);
    }
    expect(new Set(texts.map((t) => t.split("\n\n")[1])).size).toBe(4);
  });

  it("refer to another seat by letter in a Group round after round 1, and mention the note", () => {
    let table = playRound(makeTable(), TOPIC);
    table = playRound(table, "Assume we can build only one thing this quarter.");
    for (const seat of table.seats) {
      const text = seatText(table, 2, seat.id);
      expect(text).toContain("Assume we can build only one thing this quarter");
      const other = /Agent ([A-H])/.exec(text)?.[1];
      expect(other).toBeDefined();
      expect(other).not.toBe(seat.id);
    }
  });

  it("do not refer to other seats in an Independent round, and handle an empty note", () => {
    let table = playRound(makeTable({ interaction: "independent" }), TOPIC);
    table = playRound(table, "");
    for (const seat of table.seats) {
      const text = seatText(table, 2, seat.id);
      expect(text).not.toMatch(/Agent [A-H]/);
      expect(text).toContain("You added no note");
    }
  });
});

describe("mock arbiter replies", () => {
  it("are a short numbered list that mentions the seats by letter", () => {
    let table = playRound(makeTable({ arbiters: [makeArbiter(1)] }), TOPIC);
    table = playRound(table, "Pick one.");
    const text = table.rounds[1].arbiterReplies[0].text;
    const items = text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(items.length).toBe(5);
    for (const letter of ["A", "B", "C", "D"]) expect(text).toContain(`Agent ${letter} wants to`);
    expect(text).toMatch(/It (agrees|disagrees) with Agent [A-D]\./);
    // The arbiter names the same approach the seat argued for.
    const approach = /Agent A wants to (.+?)\./.exec(text)?.[1] ?? "";
    expect(seatText(table, 2, "A")).toContain(approach);
  });
});

describe("mock private replies", () => {
  it("answer the host's last message", () => {
    let table = playRound(makeTable(), TOPIC);
    table = {
      ...table,
      privateThreads: {
        B: [
          { id: "p1", role: "host", text: "What would you cut first?", status: "done", tools: [], afterRound: 1, createdAt: 0 },
          { id: "p2", role: "seat", text: "", status: "queued", tools: [], afterRound: 1, createdAt: 0 },
        ],
      },
    };
    const text = writeMockReply(buildPrivateRequest(table, "B")).text;
    expect(text).toContain('You asked "What would you cut first".');
  });
});

describe("mock tools", () => {
  it("sometimes search before the text when browsing is on", () => {
    const table = playRound(makeTable(), TOPIC);
    const seats = table.seats.map((s) => ({ ...s, browsing: true }));
    const next: Table = { ...table, seats, rounds: [...table.rounds, { ...table.rounds[0], number: 2, status: "running", seats }] };
    let searched = 0;
    for (let i = 0; i < 40; i++) {
      const reply = writeMockReply(buildSeatRequest(next, "A"));
      if (reply.tools.length > 0) {
        searched += 1;
        expect(reply.tools[0].tool).toBe("web_search");
        expect(reply.text).toContain("I searched for recent sources");
      }
    }
    expect(searched).toBeGreaterThan(0);
    expect(searched).toBeLessThan(40);
  });
});
