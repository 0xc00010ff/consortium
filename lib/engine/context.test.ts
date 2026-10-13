import { describe, expect, it } from "vitest";
import type { Attachment, PrivateMessage, Round, SpeakRequest, Table } from "@/lib/types";
import {
  buildArbiterRequest,
  buildPrivateRequest,
  buildSeatRequest,
  PRIVATE_MAX_OUTPUT_TOKENS,
  ROUND_MAX_OUTPUT_TOKENS,
} from "./context";
import { doneReply, makeArbiter, makeRound, makeSeats, makeTable, requestText } from "./test-helpers";

// A table after `finished` rounds, with round finished + 1 running and every
// reply in it queued, as the store leaves it before the seats start.
function running(table: Table, finished: number, note = "Next note."): Table {
  const rounds: Round[] = [];
  for (let n = 1; n <= finished; n++) rounds.push(makeRound(table, n, n === 1 ? "How should we price the app?" : `Note ${n}.`));
  return { ...table, rounds: [...rounds, runningRound(table, finished + 1, note)] };
}

function runningRound(table: Table, number: number, note: string): Round {
  const round = makeRound(table, number, note);
  return {
    ...round,
    status: "running",
    replies: round.replies.map((r) => ({ ...r, status: "queued", text: "" })),
    arbiterReplies: round.arbiterReplies.map((r) => ({ ...r, status: "queued", text: "" })),
  };
}

function privateMessage(role: "host" | "seat", text: string, afterRound: number, extra: Partial<PrivateMessage> = {}): PrivateMessage {
  return { id: `${role}-${text}`, role, text, status: "done", tools: [], afterRound, createdAt: 0, ...extra };
}

const image = (name: string): Attachment => ({ id: name, name, mediaType: "image/png", dataUrl: "data:image/png;base64,AAAA" });

describe("seat requests", () => {
  it("in a Group table, include other agents' earlier replies and the arbiters, and leave out the current round", () => {
    const base = makeTable({ arbiters: [makeArbiter(1)] });
    const table = running(base, 2, "Assume we can build only one thing.");
    // Agent C already finished in the current round; B must not see it.
    table.rounds[2].replies[2] = doneReply("C", "Agent C reply in round 3.", 3);
    const request = buildSeatRequest(table, "B");
    const text = requestText(request);

    expect(text).toContain("## Round 1\n\n### Host\n\nHow should we price the app?");
    expect(text).toContain("### Agent A\n\nAgent A reply in round 1.");
    expect(text).toContain("### Agent B (you)\n\nAgent B reply in round 2.");
    expect(text).toContain("### Tracker (arbiter)\n\nTracker reply in round 2.");
    expect(text).not.toContain("round 3");
    expect(text).not.toContain("## Round 3");
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].afterAttachments).toBe("# Now\n\nRound 3. The host wrote:\n\nAssume we can build only one thing.");
    expect(request.messages[0].text.startsWith("# Transcript\n\n## Round 1")).toBe(true);

    expect(request.instructions).toContain(
      "You are Agent B at a table with agents A, C and D. Each agent is an AI model. The host is the person who runs the table and speaks to it between rounds. In each round, every agent answers at the same time, so you do not see the other agents' replies from the current round.",
    );
    expect(request.instructions).toContain("You can read the other agents' replies and the arbiters' replies from earlier rounds.");
    expect(request.instructions).toContain("Reply in plain text or markdown. Keep replies to about 200 words unless the host asks for more.");
    expect(request.instructions).not.toContain("web_search");
    expect(request.modelId).toBe("test/model-b");
    expect(request.maxOutputTokens).toBe(ROUND_MAX_OUTPUT_TOKENS);
    expect(request.mockHint).toEqual({ purpose: "seat", interaction: "group", round: 3, seatId: "B" });
  });

  it("in an Independent table, leave out the other seats and the arbiters entirely", () => {
    const base = makeTable({ arbiters: [makeArbiter(1)], interaction: "independent" });
    const request = buildSeatRequest(running(base, 2), "B");
    const text = requestText(request);

    expect(text).toContain("### Agent B (you)\n\nAgent B reply in round 1.");
    expect(text).toContain("### Host\n\nNote 2.");
    expect(text).not.toMatch(/### Agent [ACD]/);
    expect(text).not.toContain("Tracker");
    expect(request.instructions).toContain("You cannot read the other agents. Answer the host directly.");
    expect(request.instructions).not.toContain("arbiters");
    expect(request.mockHint?.interaction).toBe("independent");
  });

  it("follow the setting of the round being answered, so a switch applies from the next round", () => {
    const base = makeTable();
    const table = running(base, 1);
    table.rounds[0].interaction = "independent";
    expect(requestText(buildSeatRequest(table, "B"))).toContain("### Agent A");

    table.rounds[1].interaction = "independent";
    table.rounds[0].interaction = "group";
    expect(requestText(buildSeatRequest(table, "B"))).not.toContain("### Agent A");
  });

  it("for round 1 hold only the Now section", () => {
    const request = buildSeatRequest(running(makeTable(), 0, "What should we build first?"), "A");
    expect(request.messages[0].text).toBe("");
    expect(request.messages[0].afterAttachments).toBe("# Now\n\nRound 1. The host wrote:\n\nWhat should we build first?");
  });

  it("say so when the note is empty", () => {
    const request = buildSeatRequest(running(makeTable(), 1, "  "), "A");
    expect(request.messages[0].afterAttachments).toBe(
      "# Now\n\nRound 2. The host added no note. Continue from where the table left off.",
    );
  });

  it("leave out replies that did not finish", () => {
    const table = running(makeTable(), 1);
    table.rounds[0].replies[0] = { ...table.rounds[0].replies[0], status: "error", text: "Half a reply", error: "Stopped" };
    const text = requestText(buildSeatRequest(table, "B"));
    expect(text).not.toContain("### Agent A");
    expect(text).not.toContain("Half a reply");
  });

  it("number the images in transcript order and send them before the Now section", () => {
    const table = running(makeTable(), 1, "And this one?");
    table.rounds[0].host.attachments = [image("first.png")];
    table.rounds[1].host.attachments = [image("second.png"), image("third.png")];
    const request = buildSeatRequest(table, "A");
    const message = request.messages[0];
    expect(message.attachments?.map((a) => a.name)).toEqual(["first.png", "second.png", "third.png"]);
    expect(message.text).toContain("*The host attached image 1 (first.png).*");
    expect(message.afterAttachments).toContain("The host attached images 2 and 3 (second.png, third.png) to this message.");
    expect(message.afterAttachments).toContain("The images appear above this section");
  });

  it("ask for a response to the images when round 1 has images and no text", () => {
    const table = running(makeTable(), 0, "");
    table.rounds[0].host.attachments = [image("sketch.png")];
    expect(buildSeatRequest(table, "A").messages[0].afterAttachments).toBe(
      "# Now\n\nRound 1. The host attached an image and wrote no text. Respond to the image. It is image 1 (sketch.png).\n\nThe images appear above this section, in the order they are numbered.",
    );
  });

  it("say the host added no note when a later round has only images", () => {
    const table = running(makeTable(), 1, "");
    table.rounds[1].host.attachments = [image("a.png"), image("b.png")];
    expect(buildSeatRequest(table, "A").messages[0].afterAttachments).toContain(
      "Round 2. The host attached images and added no note. They are images 1 and 2 (a.png, b.png). Continue from where the table left off, and take the images into account.",
    );
  });

  it("mention the browsing tools when browsing is on", () => {
    const table = running(makeTable(), 0, "Hello");
    table.seats[0] = { ...table.seats[0], browsing: true };
    table.rounds[0].seats = table.seats;
    const request = buildSeatRequest(table, "A");
    expect(request.browsing).toBe(true);
    expect(request.instructions).toContain("web_search tool");
    expect(request.instructions).toContain("read_page tool");
  });
});

describe("arbiter requests", () => {
  it("include this round's seat replies and earlier arbiters' replies, and never a private thread", () => {
    const base = makeTable({ arbiters: [makeArbiter(1), makeArbiter(2), makeArbiter(3)], interaction: "independent" });
    const table = running(base, 1);
    const current = table.rounds[1];
    current.replies = current.replies.map((r) => doneReply(r.participantId, `Agent ${r.participantId} now.`, 2));
    current.arbiterReplies[0] = doneReply("arbiter-1", "Tracker now.", 2);
    table.privateThreads = { B: [privateMessage("host", "Secret question", 1), privateMessage("seat", "Secret answer", 1)] };

    const request = buildArbiterRequest(table, "arbiter-2");
    const text = requestText(request);
    expect(text).toContain("## Round 2\n\n### Host\n\nNext note.");
    for (const letter of ["A", "B", "C", "D"]) expect(text).toContain(`### Agent ${letter}\n\nAgent ${letter} now.`);
    expect(text).toContain("### Tracker (arbiter)\n\nTracker now.");
    expect(text).toContain("### Arbiter 2 (arbiter, you)\n\nArbiter 2 reply in round 1.");
    expect(text).not.toContain("Arbiter 3 reply in round 2");
    expect(text).not.toContain("Secret");
    expect(text).not.toContain("Private conversation");
    expect(request.messages[0].afterAttachments).toBe(
      "# Now\n\nRound 2. The agents have answered the host. The arbiters before you have also replied. Write your reply as Arbiter 2, following the host's instructions.",
    );
    expect(request.instructions).toContain(
      "You are an arbiter named Arbiter 2 at a table of AI models. The agents are called A, B, C and D. The host runs the table. In each round, the agents answer first, and then you answer. You can read everything the host, the agents and the other arbiters have said. Follow these instructions from the host:\n\nKeep a numbered list",
    );
    expect(request.instructions.endsWith("Keep replies to about 200 words unless the host asks for more.")).toBe(true);
    expect(request.maxOutputTokens).toBe(ROUND_MAX_OUTPUT_TOKENS);
    expect(request.mockHint).toEqual({ purpose: "arbiter", interaction: "independent", round: 2, arbiterName: "Arbiter 2" });
  });
});

describe("private requests", () => {
  it("place the private thread after the round it followed, only in that seat's request", () => {
    const base = makeTable();
    const table: Table = { ...base, rounds: [makeRound(base, 1, "Start"), makeRound(base, 2, "More")] };
    table.privateThreads = {
      B: [
        privateMessage("host", "Why that price?", 1),
        privateMessage("seat", "Because of churn.", 1),
        privateMessage("host", "And now?", 2),
        privateMessage("seat", "", 2, { status: "queued" }),
      ],
    };

    const request = buildPrivateRequest(table, "B");
    const text = requestText(request);
    const afterOne = "### Private conversation between the host and you, after round 1\n\n**Host:** Why that price?\n\n**You:** Because of churn.";
    expect(text).toContain(afterOne);
    expect(text.indexOf(afterOne)).toBeGreaterThan(text.indexOf("## Round 1"));
    expect(text.indexOf(afterOne)).toBeLessThan(text.indexOf("## Round 2"));
    expect(text).toContain("### Private conversation between the host and you, after round 2\n\n**Host:** And now?");
    expect(request.messages[0].afterAttachments).toBe(
      "# Now\n\nThe host is now talking with you privately. The other agents and the arbiters do not see this. Reply to the host's last message.",
    );
    expect(request.maxOutputTokens).toBe(PRIVATE_MAX_OUTPUT_TOKENS);
    expect(request.mockHint).toEqual({ purpose: "private", interaction: "group", round: 2, seatId: "B" });

    // The next round: B carries the thread forward, the others never see it.
    const next: Table = { ...table, rounds: [...table.rounds, runningRound(table, 3, "Final round")] };
    expect(requestText(buildSeatRequest(next, "B"))).toContain(afterOne);
    expect(requestText(buildSeatRequest(next, "A"))).not.toContain("Why that price?");
    expect(requestText(buildSeatRequest(next, "A"))).not.toContain("Private conversation");
  });
});

// Everything a model reads in one request.
const everything = (request: SpeakRequest) => `${request.instructions}\n\n${requestText(request)}`;

const VOTES_SENTENCE =
  'The host votes replies up or down to reward the ones they found most useful, and can vote on a reply more than once. A reply with votes shows its score under it in the transcript, such as "Host votes: +2".';

describe("votes", () => {
  it("are not mentioned anywhere until the host votes", () => {
    const table = running(makeTable({ arbiters: [makeArbiter(1)] }), 2);
    table.rounds[0].replies[0] = { ...table.rounds[0].replies[0], votes: 0 };
    table.privateThreads = { B: [privateMessage("host", "Hi", 2)] };
    for (const request of [
      buildSeatRequest(table, "B"),
      buildArbiterRequest(table, "arbiter-1"),
      buildPrivateRequest({ ...table, rounds: table.rounds.slice(0, 2) }, "B"),
    ]) {
      expect(everything(request)).not.toMatch(/vote/i);
    }
  });

  it("after a vote, are explained to agents and arbiters and shown under the voted reply", () => {
    const table = running(makeTable({ arbiters: [makeArbiter(1)] }), 2);
    table.rounds[0].replies[0] = { ...table.rounds[0].replies[0], votes: 2 };
    table.rounds[1].arbiterReplies[0] = { ...table.rounds[1].arbiterReplies[0], votes: -1 };

    const seat = buildSeatRequest(table, "B");
    expect(seat.instructions).toContain(VOTES_SENTENCE);
    expect(requestText(seat)).toContain("### Agent A\n\nAgent A reply in round 1.\n\n*Host votes: +2*\n\n### Agent B");
    expect(requestText(seat)).toContain("### Tracker (arbiter)\n\nTracker reply in round 2.\n\n*Host votes: -1*");
    expect(requestText(seat).match(/Host votes/g)).toHaveLength(2);

    const arbiter = buildArbiterRequest(table, "arbiter-1");
    expect(arbiter.instructions).toContain(VOTES_SENTENCE);
    expect(requestText(arbiter)).toContain("Agent A reply in round 1.\n\n*Host votes: +2*");
  });

  it("show under an agent's own reply in an Independent table", () => {
    const table = running(makeTable({ interaction: "independent" }), 1);
    table.rounds[0].replies[1] = { ...table.rounds[0].replies[1], votes: 1 };
    const request = buildSeatRequest(table, "B");
    expect(requestText(request)).toContain("### Agent B (you)\n\nAgent B reply in round 1.\n\n*Host votes: +1*");
    expect(request.instructions).toContain(VOTES_SENTENCE);
  });
});

describe("host instructions", () => {
  it("to every agent reach every agent and the arbiters", () => {
    const table = running(makeTable({ arbiters: [makeArbiter(1)], instructions: "  Answer in French.  " }), 1);
    for (const request of [buildSeatRequest(table, "A"), buildSeatRequest(table, "C")]) {
      expect(request.instructions).toContain("The host gave these instructions to every agent:\n\nAnswer in French.");
    }
    const arbiter = buildArbiterRequest(table, "arbiter-1");
    expect(arbiter.instructions).toContain("The host gave these instructions to every agent:\n\nAnswer in French.");
    expect(arbiter.instructions.endsWith("Keep replies to about 200 words unless the host asks for more.")).toBe(true);
  });

  it("to one agent reach only that agent, in rounds and in private", () => {
    const seats = makeSeats(4).map((s) => (s.id === "B" ? { ...s, instructions: "Argue for the cheapest option." } : s));
    const base = makeTable({ seats, arbiters: [makeArbiter(1)], instructions: "Answer in French." });
    const table = running(base, 1);
    const own = "The host gave these instructions to you. The other agents do not see them.\n\nArgue for the cheapest option.";

    const seatB = buildSeatRequest(table, "B").instructions;
    expect(seatB).toContain(own);
    expect(seatB.indexOf("to every agent")).toBeLessThan(seatB.indexOf("to you."));
    expect(buildSeatRequest(table, "A").instructions).not.toContain("cheapest");
    expect(buildArbiterRequest(table, "arbiter-1").instructions).not.toContain("cheapest");

    const finished: Table = { ...base, rounds: [makeRound(base, 1, "Start")], privateThreads: { B: [privateMessage("host", "Why?", 1)] } };
    expect(buildPrivateRequest(finished, "B").instructions).toContain(own);
  });

  it("add nothing when blank", () => {
    const seats = makeSeats(4).map((s) => ({ ...s, instructions: "  \n " }));
    const blank = running(makeTable({ seats, arbiters: [makeArbiter(1)], instructions: "   " }), 1);
    const plain = running(makeTable({ arbiters: [makeArbiter(1)] }), 1);
    expect(buildSeatRequest(blank, "A").instructions).toBe(buildSeatRequest(plain, "A").instructions);
    expect(buildArbiterRequest(blank, "arbiter-1").instructions).toBe(buildArbiterRequest(plain, "arbiter-1").instructions);
    expect(buildSeatRequest(blank, "A").instructions).not.toContain("The host gave");
  });
});

describe("agents that are off", () => {
  // A table where the given agents were off in the current round.
  function withOff(letters: string[], finished = 1): Table {
    const seats = makeSeats(4).map((s) => (letters.includes(s.id) ? { ...s, active: false } : s));
    const table = running(makeTable({ seats, arbiters: [makeArbiter(1)] }), finished);
    const current = table.rounds[table.rounds.length - 1];
    current.replies = current.replies.filter((r) => !letters.includes(r.participantId));
    // Every agent was on in the earlier rounds.
    for (const round of table.rounds.slice(0, -1)) round.seats = makeSeats(4);
    return table;
  }

  it("are still named in the other agents' instructions", () => {
    const request = buildSeatRequest(withOff(["B", "D"]), "A");
    expect(request.instructions).toContain("You are Agent A at a table with agents B, C and D.");
  });

  it("are named in the Now section of the agents that answer", () => {
    expect(buildSeatRequest(withOff(["B", "D"]), "A").messages[0].afterAttachments).toBe(
      "# Now\n\nRound 2. Agents B and D sit out this round. The host wrote:\n\nNext note.",
    );
    expect(buildSeatRequest(withOff(["B"], 1), "A").messages[0].afterAttachments).toBe(
      "# Now\n\nRound 2. Agent B sits out this round. The host wrote:\n\nNext note.",
    );
  });

  it("are named in the arbiter's Now section, in the past tense", () => {
    expect(buildArbiterRequest(withOff(["B", "D"]), "arbiter-1").messages[0].afterAttachments).toBe(
      "# Now\n\nRound 2. Agents B and D sat out this round. No agent finished a reply in this round. Write your reply as Tracker, following the host's instructions.",
    );
  });

  it("are named under the host's message of a round they sat out, so no one thinks they failed", () => {
    const table = withOff(["B", "D"]);
    // Round 2 is over, everyone is back, and round 3 is starting.
    const round2 = table.rounds[1];
    table.rounds[1] = { ...round2, status: "done", replies: round2.replies.map((r) => doneReply(r.participantId, `Agent ${r.participantId} reply in round 2.`, 2)) };
    const allOn: Table = { ...table, seats: makeSeats(4) };
    const next: Table = { ...allOn, rounds: [...table.rounds, runningRound(allOn, 3, "Third")] };

    const text = requestText(buildSeatRequest(next, "B"));
    expect(text).toContain("## Round 2\n\n### Host\n\nNext note.\n\n*Agents B and D sat out this round.*\n\n### Agent A");
    expect(text.match(/sat out/g)).toHaveLength(1);
    expect(buildSeatRequest(next, "B").messages[0].afterAttachments).not.toContain("sit out");
    expect(requestText(buildArbiterRequest(next, "arbiter-1"))).toContain("*Agents B and D sat out this round.*");
  });

  it("are not mentioned when every agent is on", () => {
    const table = running(makeTable({ arbiters: [makeArbiter(1)] }), 1);
    expect(everything(buildSeatRequest(table, "A"))).not.toMatch(/sit out|sits out|sat out/);
    expect(everything(buildArbiterRequest(table, "arbiter-1"))).not.toMatch(/sat out/);
  });
});

describe("round robin", () => {
  // A Group table seated C, A, B, after `finished` rounds, with the next round
  // running in round robin and the given agents already done in it.
  function robin(done: string[] = [], options: { finished?: number; note?: string; interaction?: "group" | "independent"; off?: string[] } = {}): Table {
    const [a, b, c] = makeSeats(3);
    const seats = [c, a, b].map((s) => (options.off?.includes(s.id) ? { ...s, active: false } : s));
    const base = makeTable({ seats, turns: "roundRobin", interaction: options.interaction ?? "group", arbiters: [makeArbiter(1)] });
    const table = running(base, options.finished ?? 1, options.note ?? "Pick one plan.");
    const current = table.rounds[table.rounds.length - 1];
    current.turns = "roundRobin";
    current.replies = current.replies
      .filter((r) => !options.off?.includes(r.participantId))
      .map((r) => (done.includes(r.participantId) ? doneReply(r.participantId, `Agent ${r.participantId} now.`, current.number) : r));
    return table;
  }

  it("tell each agent the speaking order and where it answers, in a Group table", () => {
    const table = robin();
    const order = "In each round, the agents answer one after another, in the order C, A, B.";
    expect(buildSeatRequest(table, "C").instructions).toContain(`${order} You answer first, and the agents after you will read your reply.`);
    expect(buildSeatRequest(table, "A").instructions).toContain(
      `${order} You answer after Agent C. You can read the replies given before yours in the current round, and the agent after you will read your reply.`,
    );
    expect(buildSeatRequest(table, "B").instructions).toContain(
      `${order} You answer last, after Agent A. You can read the replies given before yours in the current round.`,
    );
    expect(buildSeatRequest(table, "A").instructions).toContain("You are Agent A at a table with agents C and B.");
    expect(buildSeatRequest(table, "A").instructions).not.toContain("at the same time");
  });

  it("leave the agents that are off out of the order", () => {
    const instructions = buildSeatRequest(robin([], { off: ["A"] }), "B").instructions;
    expect(instructions).toContain("in the order C, B. You answer last, after Agent C.");
  });

  it("give only the order in an Independent table", () => {
    const instructions = buildSeatRequest(robin(["C"], { interaction: "independent" }), "A").instructions;
    expect(instructions).toContain(
      "In each round, the agents answer one after another, in the order C, A, B. You cannot read the other agents. Answer the host directly.",
    );
    expect(instructions).not.toContain("You answer");
  });

  it("show the current round with the replies given before this agent's turn, in a Group table", () => {
    const table = robin(["C"], { finished: 2 });
    const request = buildSeatRequest(table, "A");
    const text = requestText(request);
    expect(text).toContain("## Round 3\n\n### Host\n\nPick one plan.\n\n### Agent C\n\nAgent C now.");
    expect(text).not.toContain("Agent B reply in round 3");
    expect(text.indexOf("## Round 3")).toBeGreaterThan(text.indexOf("### Tracker (arbiter)\n\nTracker reply in round 2."));
    expect(request.messages[0].afterAttachments).toBe(
      "# Now\n\nRound 3. It is your turn. Agent C has already replied this round. Reply to the host's message, and respond to Agent C where it helps.",
    );

    const last = buildSeatRequest(robin(["C", "A"], { finished: 2 }), "B");
    expect(requestText(last)).toContain("### Agent C\n\nAgent C now.\n\n### Agent A\n\nAgent A now.");
    expect(last.messages[0].afterAttachments).toBe(
      "# Now\n\nRound 3. It is your turn. Agents C and A have already replied this round. Reply to the host's message, and respond to Agents C and A where it helps.",
    );
  });

  it("say who answers first, and do not name agents whose reply did not finish", () => {
    expect(buildSeatRequest(robin([]), "C").messages[0].afterAttachments).toBe(
      "# Now\n\nRound 2. You answer first this round. Reply to the host's message.",
    );
    const table = robin([]);
    table.rounds[1].replies[0] = { ...table.rounds[1].replies[0], status: "error", error: "Stopped", text: "Half" };
    const request = buildSeatRequest(table, "A");
    expect(request.messages[0].afterAttachments).toBe("# Now\n\nRound 2. It is your turn. Reply to the host's message.");
    expect(requestText(request)).not.toContain("Half");
  });

  it("show only the host's message of the current round in an Independent table", () => {
    const request = buildSeatRequest(robin(["C"], { interaction: "independent" }), "A");
    const text = requestText(request);
    expect(text).toContain("## Round 2\n\n### Host\n\nPick one plan.");
    expect(text).not.toContain("Agent C now.");
    expect(text).not.toMatch(/### Agent [BC]/);
    expect(request.messages[0].afterAttachments).toBe("# Now\n\nRound 2. It is your turn. Reply to the host's message.");
  });

  it("say the host added no note in the transcript and the Now section", () => {
    const request = buildSeatRequest(robin(["C"], { note: " " }), "A");
    expect(requestText(request)).toContain("## Round 2\n\n### Host\n\nThe host added no note.\n\n### Agent C");
    expect(request.messages[0].afterAttachments).toBe(
      "# Now\n\nRound 2. It is your turn. Agent C has already replied this round. The host added no note. Continue from where the table left off, and respond to Agent C where it helps.",
    );
  });

  it("number the current round's images in the transcript, after the earlier ones", () => {
    const table = robin(["C"]);
    table.rounds[0].host.attachments = [image("first.png")];
    table.rounds[1].host.attachments = [image("second.png"), image("third.png")];
    const message = buildSeatRequest(table, "A").messages[0];
    expect(message.attachments?.map((a) => a.name)).toEqual(["first.png", "second.png", "third.png"]);
    expect(message.text).toContain("*The host attached image 1 (first.png).*");
    expect(message.text).toContain("## Round 2\n\n### Host\n\nPick one plan.\n\n*The host attached images 2 and 3 (second.png, third.png).*");
    expect(message.afterAttachments).toBe(
      "# Now\n\nRound 2. It is your turn. Agent C has already replied this round. Reply to the host's message, and respond to Agent C where it helps.\n\nThe images appear above this section, in the order they are numbered.",
    );
  });

  it("ask for a response to images sent with no text", () => {
    const first = robin(["C"], { finished: 0, note: "" });
    first.rounds[0].host.attachments = [image("sketch.png")];
    expect(buildSeatRequest(first, "A").messages[0].afterAttachments).toContain(
      "Round 1. It is your turn. Agent C has already replied this round. The host attached an image and wrote no text. Respond to the image, and to Agent C where it helps.",
    );
    const later = robin([], { note: "" });
    later.rounds[1].host.attachments = [image("a.png"), image("b.png")];
    expect(buildSeatRequest(later, "C").messages[0].afterAttachments).toContain(
      "Round 2. You answer first this round. The host attached images and added no note. Continue from where the table left off, and take the images into account.",
    );
  });

  it("name the agents that sit out under the current round's host message", () => {
    const text = requestText(buildSeatRequest(robin(["C"], { off: ["B"] }), "A"));
    expect(text).toContain("## Round 2\n\n### Host\n\nPick one plan.\n\n*Agent B sits out this round.*\n\n### Agent C");
  });

  it("tell the arbiters the order the agents answered in", () => {
    const table = robin(["C", "A", "B"]);
    const arbiter = buildArbiterRequest(table, "arbiter-1");
    expect(arbiter.instructions).toContain(
      "The host runs the table. In each round, the agents answer one after another, in the order C, A, B, and then you answer.",
    );
    expect(requestText(arbiter)).toContain("### Agent C\n\nAgent C now.\n\n### Agent A\n\nAgent A now.\n\n### Agent B\n\nAgent B now.");
    expect(arbiter.messages[0].afterAttachments).toBe(
      "# Now\n\nRound 2. The agents have answered the host. Write your reply as Tracker, following the host's instructions.",
    );
  });

  it("keep the private conversation's Now section, and describe the order in its instructions", () => {
    const table = robin(["C", "A", "B"]);
    table.rounds[1].status = "done";
    table.privateThreads = { A: [privateMessage("host", "Why?", 2)] };
    const request = buildPrivateRequest(table, "A");
    expect(request.instructions).toContain("in the order C, A, B. You answer after Agent C.");
    expect(request.messages[0].afterAttachments).toBe(
      "# Now\n\nThe host is now talking with you privately. The other agents and the arbiters do not see this. Reply to the host's last message.",
    );
    expect(requestText(request)).toContain("## Round 2\n\n### Host\n\nPick one plan.\n\n### Agent C");
  });
});

describe("tool models", () => {
  it("reach the request for agents and arbiters, and stay absent when none is set", () => {
    const base = makeTable({ arbiters: [makeArbiter(1, { modelId: "cli/claude-code", toolModel: "opus" })] });
    const seats = base.seats.map((s, i) => (i === 0 ? { ...s, modelId: "cli/codex", toolModel: "gpt-6-astra" } : s));
    const table = running({ ...base, seats }, 1);
    expect(buildSeatRequest(table, "A").toolModel).toBe("gpt-6-astra");
    expect(buildSeatRequest(table, "B")).not.toHaveProperty("toolModel");
    expect(buildArbiterRequest(table, "arbiter-1").toolModel).toBe("opus");
    expect(buildPrivateRequest({ ...base, seats }, "A").toolModel).toBe("gpt-6-astra");
  });
});
