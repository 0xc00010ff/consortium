import { describe, expect, it } from "vitest";
import type { PrivateMessage, Table } from "@/lib/types";
import { tableToMarkdown } from "./export";
import { doneReply, makeArbiter, makeSeats, makeTable } from "./test-helpers";

describe("tableToMarkdown", () => {
  it("writes the title, each round with every reply, and private conversations under the round they followed", () => {
    const seats = makeSeats(2);
    const tracker = makeArbiter(1);
    const table: Table = makeTable({
      title: "Pricing ideas for Habitly",
      interaction: "independent",
      seats: [{ ...seats[0], browsing: true }, seats[1]],
      arbiters: [tracker],
      rounds: [
        {
          number: 1,
          interaction: "group",
          host: {
            text: "How should we price the app?",
            attachments: [{ id: "i1", name: "funnel.png", mediaType: "image/png", dataUrl: "data:image/png;base64,AAAA" }],
            createdAt: 0,
          },
          replies: [
            {
              ...doneReply("A", "Build the guided first week.", 1),
              tools: [{ id: "t1", tool: "web_search", label: "habit app pricing", status: "done", detail: "5 results" }],
            },
            doneReply("B", "Ship the annual plan.", 1),
          ],
          arbiterReplies: [doneReply("arbiter-1", "1. Guided first week. Raised by A.\n2. Annual plan. Raised by B.", 1)],
          status: "done",
          seats,
          arbiters: [tracker],
        },
        {
          number: 2,
          interaction: "independent",
          host: { text: "", attachments: [], createdAt: 0 },
          replies: [
            doneReply("A", "Still the first week.", 2),
            { id: "r2-B", participantId: "B", text: "Half a", status: "error", error: "Stopped", tools: [] },
          ],
          arbiterReplies: [{ id: "r2-arbiter-1", participantId: "arbiter-1", text: "", status: "error", error: "Stopped", tools: [] }],
          status: "stopped",
          seats,
          arbiters: [tracker],
        },
      ],
      privateThreads: {
        B: [
          { id: "p1", role: "host", text: "What discount?", status: "done", tools: [], afterRound: 1, createdAt: 0 },
          { id: "p2", role: "seat", text: "Two months free.", status: "done", tools: [], afterRound: 1, createdAt: 0 },
        ],
      },
    });

    expect(tableToMarkdown(table)).toBe(
      [
        "# Pricing ideas for Habitly",
        [
          "- Interaction: Independent",
          "- Agents: Agent A, Claude Sonnet 5.5 (Anthropic), browsing on; Agent B, GPT-6.1 Sol (OpenAI)",
          "- Arbiters: Tracker, Arbiter Model 1 (Anthropic)",
          "- Started: 2026-10-12 09:30 UTC",
        ].join("\n"),
        "## Round 1",
        "### Host",
        "How should we price the app?",
        "*Attachments: funnel.png.*",
        "### Agent A · Claude Sonnet 5.5",
        "Build the guided first week.",
        '*Tools: searched for "habit app pricing".*',
        "### Agent B · GPT-6.1 Sol",
        "Ship the annual plan.",
        "### Tracker · Arbiter · Arbiter Model 1",
        "1. Guided first week. Raised by A.\n2. Annual plan. Raised by B.",
        "### Side conversation with Agent B, after round 1 (private)",
        "**Host:** What discount?",
        "**Agent B · GPT-6.1 Sol:** Two months free.",
        "## Round 2",
        "*Interaction changed to Independent for this round.*\n*This round was stopped.*",
        "### Host",
        "*No note.*",
        "### Agent A · Claude Sonnet 5.5",
        "Still the first week.",
        "### Agent B · GPT-6.1 Sol",
        "Half a",
        "*This reply did not finish: Stopped.*",
        "### Tracker · Arbiter · Arbiter Model 1",
        "*This reply did not finish: Stopped.*",
      ].join("\n\n") + "\n",
    );
  });

  it("names a removed seat from the round it replied in", () => {
    const table = makeTable({ seats: makeSeats(1) });
    table.rounds = [
      {
        number: 1,
        interaction: "group",
        host: { text: "Hi", attachments: [], createdAt: 0 },
        replies: [doneReply("A", "Hello.", 1), doneReply("C", "Hello from C.", 1)],
        arbiterReplies: [],
        status: "done",
        seats: makeSeats(3),
      },
    ];
    expect(tableToMarkdown(table)).toContain("### Agent C · Gemini 3.1 Pro\n\nHello from C.");
  });

  it("writes the host's instructions, the votes, and the agents that were off", () => {
    const seats = makeSeats(3).map((s) =>
      s.id === "B" ? { ...s, active: false, instructions: "Argue for the cheapest option." } : s,
    );
    const table = makeTable({
      title: "Pricing",
      seats,
      instructions: " Answer in French. ",
      rounds: [
        {
          number: 1,
          interaction: "group",
          host: { text: "Hi", attachments: [], createdAt: 0 },
          replies: [{ ...doneReply("A", "Bonjour.", 1), votes: 2 }, { ...doneReply("C", "Salut.", 1), votes: 0 }],
          arbiterReplies: [],
          status: "done",
          seats,
        },
      ],
    });

    expect(tableToMarkdown(table)).toBe(
      [
        "# Pricing",
        [
          "- Interaction: Parallel",
          "- Agents: Agent A, Claude Sonnet 5.5 (Anthropic); Agent B, GPT-6.1 Sol (OpenAI), off; Agent C, Gemini 3.1 Pro (Google)",
          "- Started: 2026-10-12 09:30 UTC",
        ].join("\n"),
        "**Instructions to every agent:**",
        "Answer in French.",
        "**Instructions to Agent B:**",
        "Argue for the cheapest option.",
        "## Round 1",
        "### Host",
        "Hi",
        "*Agent B sat out this round.*",
        "### Agent A · Claude Sonnet 5.5",
        "Bonjour.",
        "*Host votes: +2*",
        "### Agent C · Gemini 3.1 Pro",
        "Salut.",
      ].join("\n\n") + "\n",
    );
  });

  it("writes Round robin as the Interaction, a note when it changes, and private conversations in speaking order", () => {
    const [a, b, c] = makeSeats(3);
    const seats = [c, a, b];
    const round = (number: number, turns?: "parallel" | "roundRobin") => ({
      number,
      interaction: "group" as const,
      ...(turns ? { turns } : {}),
      host: { text: `Note ${number}.`, attachments: [], createdAt: 0 },
      replies: seats.map((s) => doneReply(s.id, `${s.id} in ${number}.`, number)),
      arbiterReplies: [],
      status: "done" as const,
      seats,
    });
    const table = makeTable({
      seats,
      turns: "roundRobin",
      rounds: [round(1), round(2, "roundRobin"), round(3, "roundRobin"), round(4, "parallel")],
      privateThreads: {
        A: [{ id: "p1", role: "host", text: "To A.", status: "done", tools: [], afterRound: 1, createdAt: 0 }],
        C: [{ id: "p2", role: "host", text: "To C.", status: "done", tools: [], afterRound: 1, createdAt: 0 }],
      },
    });
    const markdown = tableToMarkdown(table);
    expect(markdown).toContain("- Interaction: Round robin\n- Agents: Agent C,");
    expect(markdown).toContain("## Round 2\n\n*Interaction changed to Round robin for this round.*\n\n### Host");
    expect(markdown).toContain("## Round 3\n\n### Host");
    expect(markdown).toContain("## Round 4\n\n*Interaction changed to Parallel for this round.*\n\n### Host");
    expect(markdown.match(/Interaction changed/g)).toHaveLength(2);
    expect(markdown).toContain("### Agent C · Gemini 3.1 Pro\n\nC in 1.\n\n### Agent A · Claude Sonnet 5.5");
    expect(markdown.indexOf("Side conversation with Agent C")).toBeLessThan(markdown.indexOf("Side conversation with Agent A"));
  });
  it("writes side conversations with arbiters after the agents' ones, in arbiter order, and marks the private ones", () => {
    const seats = makeSeats(2);
    const tracker = makeArbiter(1, { modelName: "Claude Haiku 5.5" });
    const second = makeArbiter(2);
    const message = (id: string, role: "host" | "seat", text: string): PrivateMessage => ({
      id,
      role,
      text,
      status: "done",
      tools: [],
      afterRound: 1,
      createdAt: 0,
    });
    const base = makeTable({ seats, arbiters: [tracker, second] });
    const table: Table = {
      ...base,
      rounds: [
        {
          number: 1,
          interaction: "group",
          host: { text: "Start.", attachments: [], createdAt: 0 },
          replies: seats.map((s) => doneReply(s.id, `${s.id} in 1.`, 1)),
          arbiterReplies: [doneReply("arbiter-1", "Tracker in 1.", 1), doneReply("arbiter-2", "Arbiter 2 in 1.", 1)],
          status: "done",
          seats,
          arbiters: [tracker, second],
        },
      ],
      privateThreads: {
        "arbiter-2": [message("p1", "host", "To the second.")],
        "arbiter-1": [message("p2", "host", "Who is ahead?"), message("p3", "seat", "Agent B is ahead.")],
        B: [message("p4", "host", "To B.")],
      },
      threadPrivacy: { B: "shared", "arbiter-1": "private" },
    };
    const markdown = tableToMarkdown(table);
    expect(markdown).toContain(
      [
        "### Arbiter 2 · Arbiter · Arbiter Model 2",
        "Arbiter 2 in 1.",
        "### Side conversation with Agent B, after round 1",
        "**Host:** To B.",
        "### Side conversation with Tracker, after round 1 (private)",
        "**Host:** Who is ahead?",
        "**Tracker · Arbiter · Claude Haiku 5.5:** Agent B is ahead.",
        "### Side conversation with Arbiter 2, after round 1 (private)",
        "**Host:** To the second.",
      ].join("\n\n"),
    );
  });

  it("puts the host's name for an agent between the letter and the model", () => {
    const [a, b, c] = makeSeats(3);
    const seats = [{ ...a, name: "Skeptic" }, { ...b, name: " Optimist\n" }, { ...c, name: "  " }];
    const table = makeTable({
      seats,
      rounds: [
        {
          number: 1,
          interaction: "group",
          host: { text: "Hi", attachments: [], createdAt: 0 },
          replies: seats.map((s) => doneReply(s.id, `${s.id} says hi.`, 1)),
          arbiterReplies: [],
          status: "done",
          seats,
        },
      ],
      privateThreads: {
        B: [{ id: "p1", role: "seat", text: "Two months free.", status: "done", tools: [], afterRound: 1, createdAt: 0 }],
      },
    });
    const markdown = tableToMarkdown(table);
    expect(markdown).toContain(
      "- Agents: Agent A, Skeptic, Claude Sonnet 5.5 (Anthropic); Agent B, Optimist, GPT-6.1 Sol (OpenAI); Agent C, Gemini 3.1 Pro (Google)",
    );
    expect(markdown).toContain("### Agent A · Skeptic · Claude Sonnet 5.5\n\nA says hi.");
    expect(markdown).toContain("### Agent B · Optimist · GPT-6.1 Sol\n\nB says hi.");
    expect(markdown).toContain("### Agent C · Gemini 3.1 Pro\n\nC says hi.");
    expect(markdown).toContain("**Agent B · Optimist · GPT-6.1 Sol:** Two months free.");
  });
});
