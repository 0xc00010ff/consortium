// Mock mode: sample replies that let every flow run end to end with no key
// (spec section 6).
//
// Replies are written from the request's mockHint and from the text the
// models would read, so they fit the table:
//
// - Each seat holds one approach for the whole table. The approach comes from
//   the first message and the seat letter, so other seats and the arbiters can
//   name it correctly.
// - Seat replies mention the host's message. In a Group round after round 1,
//   a seat agrees or disagrees with another seat by letter.
// - Arbiter replies are a short numbered list of who holds which approach,
//   who agrees with whom, and one open question.
// - Replies in a side conversation answer the host's last message. An
//   arbiter's reply on the side also says where the agents stood in the last
//   round.
// - With browsing on, some replies start with a web search or a page read.

import type { MockHint, SeatId, SpeakEvent, SpeakRequest, ToolName } from "@/lib/types";
import { SEAT_LETTERS } from "@/lib/types";
import { NOW_HEADING } from "@/lib/engine/context";
import { mockDelayScale } from "./env";

interface MockTool {
  tool: ToolName;
  label: string;
  ok: boolean;
  detail: string;
}

export interface MockReply {
  text: string;
  tools: MockTool[];
}

// ---------- Streaming ----------

export async function* mockSpeakEvents(request: SpeakRequest, signal: AbortSignal): AsyncGenerator<SpeakEvent> {
  const started = Date.now();
  const scale = mockDelayScale();
  const reply = writeMockReply(request);

  await sleep(between(400, 1200) * scale, signal);
  if (signal.aborted) return;

  let n = 0;
  for (const tool of reply.tools) {
    const id = `mock-${started.toString(36)}-${n++}`;
    yield { type: "tool-start", id, tool: tool.tool, label: tool.label };
    await sleep(between(500, 1400) * scale, signal);
    if (signal.aborted) return;
    yield { type: "tool-end", id, ok: tool.ok, detail: tool.detail };
  }

  for (const chunk of reply.text.match(/\s*\S+/g) ?? []) {
    yield { type: "text", delta: chunk };
    await sleep(20 * scale, signal);
    if (signal.aborted) return;
  }

  yield {
    type: "done",
    usage: { inputTokens: estimateInputTokens(request), outputTokens: Math.ceil(reply.text.length / 4) },
    durationMs: Date.now() - started,
    finishReason: "stop",
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function estimateInputTokens(request: SpeakRequest): number {
  let chars = request.instructions.length;
  let images = 0;
  for (const m of request.messages) {
    chars += m.text.length + (m.afterAttachments?.length ?? 0);
    images += m.attachments?.length ?? 0;
  }
  return Math.ceil(chars / 4) + images * 1000;
}

// ---------- Randomness ----------

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length) % list.length];
}

// ---------- Approaches ----------

interface Approach {
  short: string; // completes "wants to ..." and "the first step is to ..."
  advice: string;
  reason: string;
  check: string;
}

const APPROACHES: readonly Approach[] = [
  {
    short: "start with a small pilot and expand only if it works",
    advice: "I would start with a small pilot, measure what happens, and expand only if the results hold up.",
    reason: "A pilot is cheap to run and easy to undo, and it turns a debate about guesses into a decision about evidence.",
    check: "I would change my mind if a pilot could not be run within a few weeks, because then its main advantage is gone.",
  },
  {
    short: "agree on what success looks like before doing anything else",
    advice: "Before choosing an approach, I would write down what a good result looks like and how you will measure it.",
    reason: "Many disagreements about the best option are really disagreements about the goal, and a clear measure settles most of them.",
    check: "If the goal is already clear and agreed, this step adds little, and you can move straight to the options.",
  },
  {
    short: "talk to the people affected before committing",
    advice: "I would talk to the people who will live with the result before committing to anything.",
    reason: "They know where the real problems are, and a plan they helped shape is far more likely to work in practice.",
    check: "If you already have good data on what they need, a few short conversations to confirm it are enough.",
  },
  {
    short: "look first at the cost and the time it will take",
    advice: "I would look first at what each option costs in money and time, and rule out anything you cannot keep up.",
    reason: "An option that looks good on paper but costs too much to keep running will fail later, usually at a worse moment.",
    check: "If the budget is generous, cost matters less, and the quality of the result should decide.",
  },
  {
    short: "test the main assumption first",
    advice: "I would find the one assumption the whole plan depends on and test it first.",
    reason: "If that assumption is wrong, nothing built on it will work, and it is usually quick to check.",
    check: "If no single assumption dominates, it is better to try the simplest option and learn from it.",
  },
  {
    short: "copy what has worked elsewhere and adjust it",
    advice: "I would look at how others have handled the same problem and adapt the approach that worked best for them.",
    reason: "Starting from a proven approach saves time, and the differences between their situation and yours show what to adjust.",
    check: "If your situation is unusual in an important way, the examples may mislead more than they help.",
  },
  {
    short: "keep the plan simple and cut what is not essential",
    advice: "I would keep the plan as simple as possible and cut everything that is not needed for the first result.",
    reason: "Each extra part adds work and risk, and most of the value usually comes from a small part of the plan.",
    check: "If something I would cut is what people actually care about, it belongs in the first version.",
  },
  {
    short: "plan for the main risks before they happen",
    advice: "I would list the main risks now and decide in advance what you will do if each one happens.",
    reason: "Problems are much cheaper to handle when the response is already agreed, and the list often shows which option is safest.",
    check: "If the decision is easy to reverse, a lighter plan is enough, and speed matters more.",
  },
];

// The approach a seat holds for the whole table. Seats at one table always
// hold different approaches.
function approachOf(topicSeed: number, seatId: string): Approach {
  const index = Math.max(0, (SEAT_LETTERS as readonly string[]).indexOf(seatId));
  return APPROACHES[(topicSeed + index * 3) % APPROACHES.length];
}

const OPENERS: Record<SeatId, readonly string[]> = {
  A: [
    "I will go through this step by step, starting with the first decision you need to make.",
    "I will set out my view in order, starting with what I would do first.",
  ],
  B: [
    "I will focus on what a small team can realistically do in the next few weeks.",
    "My answer is based on what is practical to do with the time and people you have.",
  ],
  C: [
    "Some of the risks here are easy to miss, so I will be careful about what I recommend.",
    "I will keep my recommendation cautious, because a few of the risks are hard to undo.",
  ],
  D: [
    "My view differs a little from the usual answer, and I will explain why.",
    "I am not fully convinced by the common view, so I will offer a different one.",
  ],
  E: [
    "I find it helps to look at the wider goal before choosing a first step.",
    "Before getting into details, I will look at what you are trying to achieve overall.",
  ],
  F: [
    "A few details change the answer in this case, so I will be specific about them.",
    "The details matter a great deal here, so I will name the ones that count most.",
  ],
  G: [
    "I will start with the people this affects, because their needs should shape the plan.",
    "My answer starts from the people who will live with the result.",
  ],
  H: [
    "I will look at the cost first, because it limits every other option.",
    "Cost usually gets less attention than it deserves, so I will start there.",
  ],
};

const OPEN_QUESTIONS = [
  "nobody has said how success will be measured.",
  "nobody has estimated how long the first step would take.",
  "the table has not discussed what happens if the first step fails.",
  "it is not yet clear who would own the work.",
  "nobody has asked what the people affected actually want.",
];

// ---------- Reading the request ----------

interface Context {
  hint: MockHint;
  seatId: SeatId;
  arbiterName: string;
  transcript: string;
  now: string;
  topic: string; // the host's first message
  topicSeed: number;
  note: string; // the host's message for this round, or "" for no note
  seats: SeatId[]; // every seat at the table
  imageInNow: boolean;
  browsing: boolean;
  rand: () => number;
}

function readContext(request: SpeakRequest): Context {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  const transcript = last?.text ?? "";
  const after = last?.afterAttachments ?? "";
  const now = after.includes(NOW_HEADING) ? after : (transcript.split(NOW_HEADING)[1] ?? after);
  const hint = request.mockHint ?? inferHint(request.instructions, now);

  const seatId = hint.seatId ?? ((/You are Agent ([A-H])/.exec(request.instructions)?.[1] as SeatId | undefined) ?? "A");
  const arbiterName = hint.arbiterName ?? /You are an arbiter named (.+?) at a table/.exec(request.instructions)?.[1] ?? "Arbiter";

  let note = "";
  const wrote = now.indexOf("The host wrote:");
  if (wrote >= 0) {
    note = now
      .slice(wrote + "The host wrote:".length)
      .split(/\n\n(?=The host attached |The images appear above)/)[0]
      .trim();
  }
  const firstHost = hostBlock(transcript, 1);
  const topic = firstHost ?? (hint.round <= 1 ? note : "");

  return {
    hint,
    seatId,
    arbiterName,
    transcript,
    now,
    topic,
    topicSeed: hashString(topic.trim()),
    note,
    seats: seatsFrom(request.instructions, seatId, hint.purpose),
    imageInNow: /The host attached (an image|images?\b)/.test(now),
    browsing: request.browsing,
    rand: seeded(hashString(`${topic}|${seatId}|${arbiterName}|${hint.round}|${Math.random()}`)),
  };
}

function inferHint(instructions: string, now: string): MockHint {
  const arbiter = instructions.startsWith("You are an arbiter");
  const purpose = /talking with you (privately|on the side)/.test(now) ? "private" : arbiter ? "arbiter" : "seat";
  const round = Number(/Round (\d+)\./.exec(now)?.[1] ?? "1");
  const interaction = /You cannot read the other agents/.test(instructions) ? "independent" : "group";
  const arbiterName = arbiter ? (/You are an arbiter named (.+?) at a table/.exec(instructions)?.[1] ?? "Arbiter") : undefined;
  return { purpose, interaction, round, ...(arbiterName ? { arbiterName } : {}) };
}

function seatsFrom(instructions: string, seatId: SeatId, purpose: MockHint["purpose"]): SeatId[] {
  const pattern =
    purpose === "arbiter" ? /The agents are called ([A-H](?:, [A-H])*(?: and [A-H])?)\./ : /with agents? ([A-H](?:, [A-H])*(?: and [A-H])?)\./;
  const listed = (pattern.exec(instructions)?.[1].match(/[A-H]/g) ?? []) as SeatId[];
  const all = purpose === "arbiter" ? listed : [...listed, seatId];
  return [...new Set(all)].sort() as SeatId[];
}

// One round's section of the transcript, without the heading.
function roundSection(transcript: string, round: number): string | null {
  const start = transcript.indexOf(`## Round ${round}\n`);
  if (start < 0) return null;
  const rest = transcript.slice(start + `## Round ${round}\n`.length);
  const end = rest.search(/^## Round \d+\n/m);
  return end < 0 ? rest : rest.slice(0, end);
}

function hostBlock(transcript: string, round: number): string | null {
  const section = roundSection(transcript, round);
  if (!section) return null;
  const match = /### Host\n\n([\s\S]*?)(?=\n\n### |\n\n\*The host attached|$)/.exec(section);
  const text = match?.[1].trim() ?? "";
  return text && text !== "The host added no note." ? text : null;
}

// The seat replies in one round, by letter.
function seatReplies(transcript: string, round: number): Map<SeatId, string> {
  const replies = new Map<SeatId, string>();
  const section = roundSection(transcript, round);
  if (!section) return replies;
  // (?![\s\S]) is the end of the text; "$" would match at every line end here.
  const pattern = /^### Agent ([A-H])(?: \(you\))?\n\n([\s\S]*?)(?=\n\n### |(?![\s\S]))/gm;
  for (const match of section.matchAll(pattern)) replies.set(match[1] as SeatId, match[2]);
  return replies;
}

function lastRoundNumber(transcript: string): number {
  let last = 0;
  for (const match of transcript.matchAll(/^## Round (\d+)$/gm)) last = Math.max(last, Number(match[1]));
  return last;
}

// The last message the host sent in this participant's own side
// conversation, and how many the host has sent in its latest part. The block
// ends at the next heading, since side conversations with others can follow.
function lastPrivateMessage(transcript: string): { text: string; count: number } {
  const heading = "### Side conversation between the host and you";
  const start = transcript.lastIndexOf(heading);
  let block = start >= 0 ? transcript.slice(start) : transcript;
  if (start >= 0) {
    const end = block.slice(heading.length).search(/\n\n#{1,3} /);
    if (end >= 0) block = block.slice(0, heading.length + end);
  }
  const messages = [...block.matchAll(/^\*\*Host:\*\* ([\s\S]*?)(?=\n\n\*\*You:\*\*|\n\n\*\*Host:\*\*|\n\n\*The host attached|\n\n##|(?![\s\S]))/gm)].map((m) =>
    m[1].trim(),
  );
  return { text: messages[messages.length - 1] ?? "", count: messages.length };
}

function shorten(text: string, limit = 80): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  const clean = line.replace(/[.?!:;,]+$/, "");
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 30))}...`;
}

function lowerFirst(text: string): string {
  return /^I\b/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

// ---------- Tools ----------

function toolsFor(ctx: Context, chance: number): MockTool[] {
  if (!ctx.browsing || ctx.rand() >= chance) return [];
  const subject = shorten(ctx.note || ctx.topic, 60) || "this question";
  const suffix = pick(ctx.rand, ["evidence", "recent examples", "costs and risks", "best practices", "case studies"]);
  const tools: MockTool[] = [
    { tool: "web_search", label: `${subject} ${suffix}`, ok: true, detail: `${3 + Math.floor(ctx.rand() * 3)} results` },
  ];
  if (ctx.rand() < 0.4) {
    const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "article";
    tools.push({
      tool: "read_page",
      label: `https://www.example.org/guides/${slug}`,
      ok: true,
      detail: pick(ctx.rand, ["An overview of the main options", "A summary of recent findings", "A practical guide"]),
    });
  }
  return tools;
}

function toolNote(tools: MockTool[]): string {
  if (tools.length === 0) return "";
  return tools.some((t) => t.tool === "read_page")
    ? " I searched for recent sources and read one of them in full before writing this."
    : " I searched for recent sources before writing this.";
}

// ---------- Replies ----------

export function writeMockReply(request: SpeakRequest): MockReply {
  const ctx = readContext(request);
  if (ctx.hint.purpose === "arbiter") return arbiterReply(ctx);
  if (ctx.hint.purpose === "private") return ctx.hint.arbiterName && !ctx.hint.seatId ? arbiterPrivateReply(ctx) : privateReply(ctx);
  return seatReply(ctx);
}

function seatReply(ctx: Context): MockReply {
  const { hint, seatId } = ctx;
  const mine = approachOf(ctx.topicSeed, seatId);
  const tools = toolsFor(ctx, 0.35);
  const image = ctx.imageInNow ? " I also looked at the image you attached, and it fits this view." : "";
  const paragraphs: string[] = [];

  if (hint.round <= 1) {
    const subject = shorten(ctx.topic);
    const frame = subject ? pick(ctx.rand, [`Here is my answer to "${subject}".`, `You asked about "${subject}".`]) : "";
    paragraphs.push([pick(ctx.rand, OPENERS[seatId]), frame, mine.advice].filter(Boolean).join(" "));
    paragraphs.push(`${mine.reason}${toolNote(tools)}${image}`);
    if (ctx.rand() < 0.6) paragraphs.push(mine.check);
    return { text: paragraphs.join("\n\n"), tools };
  }

  const still = pick(ctx.rand, [
    `I still think the first step is to ${mine.short}.`,
    `I have not changed my view, and I would ${mine.short}.`,
    `I would still ${mine.short}.`,
  ]);
  const opening = ctx.note
    ? `Given your note, "${shorten(ctx.note)}", ${still}`
    : `You added no note, so I will pick up where the table left off. ${still}`;
  paragraphs.push(`${opening}${toolNote(tools)}${image}`);

  if (hint.interaction === "group") {
    const other = otherSeat(ctx);
    if (other) {
      const theirs = approachOf(ctx.topicSeed, other);
      const agree = ctx.rand() < 0.5;
      paragraphs.push(
        agree
          ? `I agree with Agent ${other} that it makes sense to ${theirs.short}. It fits with my point, because ${lowerFirst(mine.reason)}`
          : `I see it differently from Agent ${other}, who wants to ${theirs.short}. ${mine.reason}`,
      );
      if (hint.round >= 3 && ctx.rand() < 0.6) {
        paragraphs.push(`A combined plan could work: ${mine.short}, then ${theirs.short}.`);
      } else {
        paragraphs.push(mine.check);
      }
      return { text: paragraphs.join("\n\n"), tools };
    }
  }

  paragraphs.push(`${mine.reason} ${mine.check}`);
  return { text: paragraphs.join("\n\n"), tools };
}

// Another seat to respond to: one that replied in the last round shown, or
// any other seat at the table.
function otherSeat(ctx: Context): SeatId | null {
  const recent = [...seatReplies(ctx.transcript, lastRoundNumber(ctx.transcript)).keys()].filter((id) => id !== ctx.seatId);
  const pool = recent.length > 0 ? recent : ctx.seats.filter((id) => id !== ctx.seatId);
  return pool.length > 0 ? pick(ctx.rand, pool) : null;
}

function arbiterReply(ctx: Context): MockReply {
  const round = ctx.hint.round;
  const replies = seatReplies(ctx.transcript, round);
  const tools = toolsFor(ctx, 0.2);
  if (replies.size === 0) {
    return {
      text: `No agent finished a reply in round ${round}, so there is nothing new to track. The list from the last round still stands.`,
      tools,
    };
  }

  const lines: string[] = [];
  for (const [seatId, text] of [...replies].sort(([a], [b]) => a.localeCompare(b))) {
    let line = `Agent ${seatId} wants to ${approachOf(ctx.topicSeed, seatId).short}.`;
    const agrees = /I agree with Agent ([A-H])/.exec(text)?.[1];
    const differs = /differently from Agent ([A-H])/.exec(text)?.[1];
    if (agrees) line += ` It agrees with Agent ${agrees}.`;
    else if (differs) line += ` It disagrees with Agent ${differs}.`;
    lines.push(line);
  }
  lines.push(`Open question: ${pick(ctx.rand, OPEN_QUESTIONS)}`);

  const intro = pick(ctx.rand, [
    `Here is where the table stands after round ${round}.`,
    `Here is what each agent said in round ${round}, and where they stand.`,
  ]);
  const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
  return { text: `${intro}${toolNote(tools)}\n\n${numbered}`, tools };
}

function privateReply(ctx: Context): MockReply {
  const mine = approachOf(ctx.topicSeed, ctx.seatId);
  const { text, count } = lastPrivateMessage(ctx.transcript);
  const tools = toolsFor(ctx, 0.2);
  const asked = shorten(text) || "your message";
  const question = text.trim().endsWith("?");

  const first = question
    ? `You asked "${asked}". My direct answer is that I would ${mine.short}, and keep the first step small enough to change course quickly.`
    : `Thank you, that detail is useful. Given what you said ("${asked}"), I would still ${mine.short}, but I would move faster on it.`;
  const second = count > 1 ? `That builds on what we discussed a moment ago. ${mine.check}` : mine.reason;
  const kept = /talking with you privately/.test(ctx.now);
  const close = pick(
    ctx.rand,
    kept
      ? ["This stays between us. If you want the table to hear it, say so in your next note.", "I can raise this with the table in the next round if you want.", ""]
      : ["The others can read this from the next round, so I expect some of them to push back.", ""],
  );
  return { text: [`${first}${toolNote(tools)}`, second, close].filter(Boolean).join("\n\n"), tools };
}

// An arbiter answers the host's last message, then says where each agent
// stood in the last round it read.
function arbiterPrivateReply(ctx: Context): MockReply {
  const { text } = lastPrivateMessage(ctx.transcript);
  const tools = toolsFor(ctx, 0.2);
  const asked = shorten(text) || "your message";
  const first = text.trim().endsWith("?")
    ? `You asked "${asked}". Here is my answer as ${ctx.arbiterName}, based on what the table has said so far.`
    : `Thank you. As ${ctx.arbiterName}, I will keep "${asked}" in mind in the next round.`;
  const round = lastRoundNumber(ctx.transcript);
  const agents = [...seatReplies(ctx.transcript, round).keys()].sort();
  const standing =
    agents.length > 0
      ? agents.map((id) => `Agent ${id} wants to ${approachOf(ctx.topicSeed, id).short}.`).join(" ")
      : "The agents have not answered yet, so there is nothing to track.";
  return { text: [`${first}${toolNote(tools)}`, standing].join("\n\n"), tools };
}
