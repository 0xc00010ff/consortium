// Realistic tables for building and reviewing the interface without the engine.
// Open them in development at /#/preview/new, group, independent, running or demo.

import type {
  Arbiter,
  Attachment,
  HostMessage,
  ModelsResponse,
  PrivateMessage,
  Reply,
  Round,
  Seat,
  SeatId,
  Table,
  TableEdit,
  TableStore,
  ThreadPrivacy,
  ToolActivity,
} from "@/lib/types";
import { SUMMARIZER_INSTRUCTIONS, SUMMARIZER_NAME } from "@/lib/engine/table";
import { isBusy } from "./view";

export const FIXTURE_MODELS: ModelsResponse = {
  mock: true,
  models: [
    {
      id: "cli/claude-code",
      name: "Claude Code",
      maker: "anthropic",
      defaultModel: "Sonnet 4.5",
      toolModels: [
        { id: "fable", name: "Fable" },
        { id: "opus", name: "Opus" },
        { id: "sonnet", name: "Sonnet" },
        { id: "haiku", name: "Haiku" },
      ],
    },
    {
      id: "cli/codex",
      name: "Codex",
      maker: "openai",
      defaultModel: "gpt-6-astra",
      toolModels: [
        { id: "gpt-6-astra", name: "GPT-6 Astra" },
        { id: "gpt-6-pro", name: "GPT-6 Pro" },
        { id: "gpt-6-sol", name: "GPT-6 Sol" },
        { id: "gpt-6-luna", name: "GPT-6 Luna" },
      ],
    },
    { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", maker: "anthropic" },
    { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", maker: "anthropic" },
    { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", maker: "anthropic" },
    { id: "openai/gpt-6-astra", name: "GPT-6 Astra", maker: "openai" },
    { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", maker: "openai" },
    { id: "openai/gpt-6-luna", name: "GPT-6 Luna", maker: "openai" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", maker: "google" },
    { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", maker: "google" },
    { id: "spacexai/grok-4.7", name: "Grok 4.7", maker: "xai" },
    { id: "spacexai/grok-4.1-fast-reasoning", name: "Grok 4.1 Fast Reasoning", maker: "xai" },
  ],
  defaults: {
    seats: ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol", "google/gemini-3.1-pro-preview", "spacexai/grok-4.7"],
    arbiter: "anthropic/claude-haiku-5.5",
  },
};

export const FIXTURE_NAMES = ["new", "group", "independent", "running", "demo"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

const T0 = Date.UTC(2026, 9, 12, 14, 0, 0);

function seats(letters: SeatId[] = ["A", "B", "C", "D"], browsingOff: SeatId[] = []): Seat[] {
  const all: Record<string, Omit<Seat, "id" | "browsing">> = {
    A: { modelId: "anthropic/claude-sonnet-5.5", modelName: "Claude Sonnet 5.5", maker: "anthropic" },
    B: { modelId: "openai/gpt-6.1-sol", modelName: "GPT-6.1 Sol", maker: "openai" },
    C: { modelId: "google/gemini-3.1-pro-preview", modelName: "Gemini 3.1 Pro Preview", maker: "google" },
    D: { modelId: "spacexai/grok-4.7", modelName: "Grok 4.7", maker: "xai" },
  };
  return letters.map((id) => ({ id, ...all[id], browsing: !browsingOff.includes(id) }));
}

const TRACKER: Arbiter = {
  id: "arbiter-1",
  name: "Tracker",
  modelId: "anthropic/claude-haiku-5.5",
  modelName: "Claude Haiku 5.5",
  maker: "anthropic",
  browsing: false,
  instructions:
    "Keep a numbered list of every idea raised, who raised it, and who supports it. End with the open questions. Do not add ideas of your own.",
};

let n = 0;
const nid = (p: string) => `${p}-${++n}`;

function reply(participantId: string, text: string, extra: Partial<Reply> = {}): Reply {
  return {
    id: nid("reply"),
    participantId,
    text,
    status: "done",
    tools: [],
    durationMs: 3900 + ((n * 1733) % 5200),
    usage: { inputTokens: 1800 + ((n * 977) % 5200), outputTokens: 140 + ((n * 131) % 260) },
    startedAt: T0 + n * 1000,
    finishReason: "stop",
    ...extra,
  };
}

function round(number: number, p: Omit<Round, "number" | "status" | "interaction"> & Partial<Round>): Round {
  return { number, status: "done", interaction: "group", ...p };
}

function host(text: string, attachments: Attachment[] = [], at = T0): Round["host"] {
  return { text, attachments, createdAt: at };
}

function pm(role: PrivateMessage["role"], text: string, afterRound: number, durationMs?: number): PrivateMessage {
  return {
    id: nid("pm"),
    role,
    text,
    status: "done",
    tools: [],
    afterRound,
    createdAt: T0 + n * 1000,
    ...(durationMs ? { durationMs } : {}),
  };
}

function tool(t: ToolActivity["tool"], label: string, status: ToolActivity["status"] = "done", detail?: string): ToolActivity {
  return { id: nid("tool"), tool: t, label, status, ...(detail ? { detail } : {}) };
}

// A small drawing of a checkout screen, used as an image attachment.
const CHECKOUT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" fill="#F4F5F2"/><rect x="24" y="24" width="270" height="272" rx="10" fill="#fff" stroke="#DADDD8"/><rect x="44" y="46" width="120" height="12" rx="3" fill="#2B2F2D"/><rect x="44" y="76" width="230" height="30" rx="6" fill="#fff" stroke="#C9CDC8"/><rect x="44" y="118" width="110" height="30" rx="6" fill="#fff" stroke="#C9CDC8"/><rect x="164" y="118" width="110" height="30" rx="6" fill="#fff" stroke="#C9CDC8"/><rect x="44" y="160" width="230" height="30" rx="6" fill="#fff" stroke="#C9CDC8"/><rect x="44" y="210" width="110" height="34" rx="7" fill="#1F6F5B"/><rect x="164" y="210" width="110" height="34" rx="7" fill="#111"/><rect x="310" y="24" width="146" height="170" rx="10" fill="#fff" stroke="#DADDD8"/><rect x="326" y="44" width="80" height="10" rx="3" fill="#2B2F2D"/><rect x="326" y="70" width="114" height="8" rx="3" fill="#C9CDC8"/><rect x="326" y="88" width="96" height="8" rx="3" fill="#C9CDC8"/><rect x="326" y="118" width="114" height="26" rx="6" fill="#fff" stroke="#E0A13A" stroke-dasharray="4 3"/><rect x="326" y="160" width="60" height="12" rx="3" fill="#2B2F2D"/></svg>`;

const CHECKOUT_IMAGE: Attachment = {
  id: "img-checkout",
  name: "checkout-v3.png",
  mediaType: "image/svg+xml",
  dataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(CHECKOUT_SVG)}`,
};

// ---------- a new table ----------

function newFixture(): Table {
  return {
    id: "preview-new",
    title: "Untitled conversation",
    createdAt: T0,
    updatedAt: T0,
    interaction: "group",
    seats: seats(["A", "B", "C", "D"], ["D"]),
    arbiters: [],
    rounds: [],
    privateThreads: {},
  };
}

// ---------- a Group table after two rounds ----------

// Round 1 ran in parallel in letter order. Before round 2 the host moved C to
// the front, switched to round robin, named B "Skeptic" and made C teal, so
// round 2 ran C, A, B, D and round 1 keeps B's model name and C's purple.
function groupFixture(): Table {
  const s = seats(["A", "B", "C", "D"], ["D"]);
  const s2 = seats(["C", "A", "B", "D"], ["D"]).map((seat): Seat => {
    if (seat.id === "B") return { ...seat, name: "Skeptic" };
    if (seat.id === "C") return { ...seat, color: "teal" };
    return seat;
  });
  const r1 = round(1, {
    seats: s,
    arbiters: [TRACKER],
    host: host(
      "Habitly is a habit tracking app with about 40,000 monthly active users. 2.1 percent of free users convert to the 12 dollar monthly plan. What should we try first to raise revenue?",
    ),
    replies: [
      reply(
        "A",
        "Start with activation, not price. At 2.1 percent conversion, most free users never reach the point where paying makes sense, because they stop opening the app in the first week.\n\nI would build a guided first week: one small habit, a reminder at the time the user picks, and a short check-in on day three. If more people form the habit, more of them hit the paywall with a reason to pay.",
      ),
      reply(
        "B",
        "Add an annual plan. It is the cheapest change with a direct effect on revenue: it brings cash forward and it cuts churn for the people who are most likely to leave after two or three months.\n\n- Price it at about 96 dollars a year.\n- Show it as the default on the paywall, with monthly as the second option.\n- Measure take rate and 90-day churn against the current plan.",
      ),
      reply(
        "C",
        "A family plan could open a new group of payers. Habit apps spread inside households, and a plan for up to five people at 20 dollars a month would let one payer bring others in.\n\nI checked how similar apps price this. Most family plans cost 1.5 to 2 times the single plan.",
        { tools: [tool("web_search", "habit tracker app family plan pricing", "done", "6 results")] },
      ),
      reply(
        "D",
        "Test the price before building anything. Raise the monthly price to 15 dollars for half of new signups for two weeks. If conversion holds, you have found revenue with no engineering work at all.",
      ),
    ],
    arbiterReplies: [
      reply(
        TRACKER.id,
        "**Ideas on the table**\n\n1. Guided first week. Raised by A.\n2. Annual plan at about 96 dollars. Raised by B.\n3. Family plan at 20 dollars a month. Raised by C.\n4. Price test at 15 dollars. Raised by D.\n\n**Open questions.** No agent has said which idea comes first if only one can be built.",
      ),
    ],
  });
  const r2 = round(2, {
    turns: "roundRobin",
    seats: s2,
    arbiters: [TRACKER],
    host: host(
      "Assume we can only build one thing this quarter. Argue for one, and say what would change your mind.",
      [],
      T0 + 600_000,
    ),
    replies: [
      reply(
        "C",
        "I now lean toward A. A family plan brings in new payers, but only after activation works, so it is a second-quarter idea. The one thing I would check first is where in week one people stop opening the app.",
        { durationMs: 9000 },
      ),
      reply(
        "A",
        "Build the guided first week. Conversion is low because most free users never form the habit, so the paywall never becomes relevant. B’s annual plan only helps people who already pay. I would change my mind if week-one retention is already above 40 percent, because then the funnel problem is later.\n\nHere is what the first week would include:\n\n1. **Day 1.** The user picks one small habit from a short list and sets a reminder time.\n2. **Day 2.** A check-in at the reminder time, with one tap to mark the habit done.\n3. **Day 3.** A short message that shows the streak so far and suggests a smaller version of the habit for busy days.\n4. **Day 5.** An offer to add a second habit, only if the first one has been done at least three times.\n5. **Day 7.** A summary of the week, and the first mention of the paid plan, tied to what the user has already done.\n\nThe work is mostly copy and scheduling, so two people could ship it in about three weeks. I would measure it by the share of new users who open the app on day 7, and by conversion at day 30.\n\nThe main risk is that more reminders feel like nagging. I would cap the first week at one message a day and let people turn reminders off from the first screen.",
        { durationMs: 8100, votes: 2 },
      ),
      reply(
        "B",
        "Ship the annual plan. It is a week of work, it raises cash now, and it cuts churn for the people most likely to leave. A is right that activation is the bigger lever, but it is also the bigger project. I would change my mind if fewer than a third of current payers would take a discount for a year up front.",
        { durationMs: 6400 },
      ),
      reply(
        "D",
        "Price test before either. Raise the monthly price to 15 dollars for half of new signups for two weeks. It costs nothing to build and tells you how much room there is. If conversion drops by more than a quarter, I agree with A.",
        { durationMs: 5200, votes: -1 },
      ),
    ],
    arbiterReplies: [
      reply(
        TRACKER.id,
        "**Ideas on the table**\n\n1. Guided first week. Raised by A. Supported by C.\n2. Annual plan. Raised by B.\n3. Price test at 15 dollars. Raised by D, as a step before the others.\n4. Family plan. Raised by C in round 1, now deferred by C.\n\n**Open question.** Nobody has a number for week-one retention. A and D both said it would change their view.",
        { durationMs: 3900, votes: 1 },
      ),
    ],
  });
  // Settings the host changed after round 2. They apply from round 3.
  const now: Seat[] = s2.map((seat) => {
    if (seat.id === "A") return { ...seat, modelId: "cli/claude-code", modelName: "Claude Code", maker: "anthropic", toolModel: "opus" };
    if (seat.id === "B")
      return {
        ...seat,
        instructions:
          "Argue for the annual plan whatever the others say.\nIf you change your mind, say which reply changed it.",
      };
    if (seat.id === "D") return { ...seat, active: false };
    return seat;
  });
  return {
    id: "preview-group",
    title: "Pricing ideas for Habitly",
    createdAt: T0,
    updatedAt: T0 + 900_000,
    interaction: "group",
    turns: "roundRobin",
    instructions: "Answer in one short paragraph unless the host asks for more.",
    seats: now,
    arbiters: [TRACKER],
    rounds: [r1, r2],
    privateThreads: {
      [TRACKER.id]: [
        pm("host", "Which idea has the most support so far?", 1),
        pm(
          "seat",
          "None yet. Each agent raised a different idea and no agent has backed another, so each of the four has one supporter. Round 2 should show whether any of them gains support.",
          1,
          3200,
        ),
      ],
      B: [
        pm("host", "How would you price the annual plan, and what discount?", 2),
        pm(
          "seat",
          "96 dollars a year, which is two months free against 144 dollars monthly. That is the discount most subscription apps settle on, and it is large enough to feel like a real offer without halving your revenue per user.",
          2,
          4800,
        ),
        pm("host", "Monthly churn is already low, about 3 percent. Does that weaken your case?", 2),
        pm(
          "seat",
          "Yes, somewhat. At 3 percent the churn saving is small, so the annual plan becomes mostly a cash-flow move. I would still ship it, but I would no longer argue it beats A’s first-week work. I will say so if the host asks.",
          2,
          5100,
        ),
      ],
    },
    threadPrivacy: { [TRACKER.id]: "shared", B: "private" },
  };
}

// ---------- an Independent table ----------

function independentFixture(): Table {
  const s = seats(["A", "B", "C"]);
  return {
    id: "preview-independent",
    title: "Checkout screen review",
    createdAt: T0 - 3 * 86_400_000,
    updatedAt: T0 - 3 * 86_400_000,
    interaction: "independent",
    seats: s,
    arbiters: [],
    rounds: [
      round(1, {
        interaction: "independent",
        seats: s,
        arbiters: [],
        host: host(
          "Here is the new checkout screen. What would you change before we ship it? Keep it to the three most important changes.",
          [CHECKOUT_IMAGE],
        ),
        replies: [
          reply(
            "A",
            "1. **Make one button primary.** The green and black buttons have the same weight, so the eye has no clear next step. Keep Pay as the filled button and make the other one a text link.\n2. **Label the dashed field.** The box in the order summary looks like a promo code field, but it has no label. A plain label such as `Promo code` avoids the guess.\n3. **Group the card fields.** Card number, expiry and security code should read as one block, with the expiry and code on one line.",
          ),
          reply(
            "B",
            "The layout is clean, and the order summary on the right is the right call. Three changes:\n\n1. Put the total next to the Pay button, so people do not have to look across the page to see what they are paying.\n2. Show the accepted card types near the card number field.\n3. Move the promo code field below the total, collapsed behind a link. An open promo field sends people off to search for a code.",
            {
              tools: [
                tool("read_page", "https://baymard.com/blog/checkout-flow-average-form-fields", "done", "Read 2,400 words"),
              ],
            },
          ),
          reply("C", "", {
            status: "error",
            error: "The model took too long to answer. Agent C will be asked again in the next round, or you can pick a different model for it.",
            durationMs: undefined,
            usage: undefined,
          }),
        ],
        arbiterReplies: [],
      }),
    ],
    privateThreads: {},
  };
}

// ---------- a round in progress ----------

function runningFixture(): Table {
  const s = seats();
  const arbiter: Arbiter = {
    ...TRACKER,
    id: "arbiter-1",
    name: "Judge",
    instructions: "After each round, say which agent made the strongest argument and why, in three sentences or fewer.",
  };
  return {
    id: "preview-running",
    title: "Determinism and blame",
    createdAt: T0 - 86_400_000,
    updatedAt: T0 - 86_400_000,
    interaction: "group",
    seats: s,
    arbiters: [arbiter],
    rounds: [
      round(1, {
        seats: s,
        arbiters: [arbiter],
        host: host("If every choice has prior causes, can anyone deserve blame? Take a side and defend it briefly."),
        replies: [
          reply(
            "A",
            "Yes. Blame depends on whether a person responds to reasons, not on whether their choice had causes. Someone who would have acted differently given a good reason is the kind of agent our practice of blame is built for, and determinism leaves that capacity intact.",
          ),
          reply(
            "B",
            "No. Deserving blame requires that the person be the true source of what they did. If every choice follows from causes that reach back before the person existed, the source lies outside them.",
          ),
          reply(
            "C",
            "A qualified yes. We can deserve some blame, but less than our practices assume. The forward-looking reasons for blame survive determinism. The backward-looking idea of pure desert does not.",
          ),
          reply(
            "D",
            "No, and the practical case does not need it. We can hold people to account, protect others and encourage change without claiming anyone deserves to suffer for what they did.",
          ),
        ],
        arbiterReplies: [
          reply(
            arbiter.id,
            "B made the strongest argument. It names the condition for desert precisely and shows why determinism removes it. A answers a slightly different question, about responsiveness to reasons, without showing that responsiveness is enough for desert.",
          ),
        ],
      }),
      round(2, {
        status: "running",
        seats: s,
        arbiters: [arbiter],
        host: host("", [], T0 + 300_000),
        replies: [
          reply(
            "A",
            "B says the source of a choice must lie inside the person. But no account of agency can meet that standard, including the ones B would accept in ordinary life.\n\nWhen we say someone acted of their own accord, we mean that the action flowed from their values and their reasoning, and that it would have changed if their reasons had changed. We do not mean that they created those values from nothing. Nobody does.\n\nThe manipulation case is the best argument B has, so here is my answer to it. What makes the manipulated agent seem blameless is not that their values have causes. It is that the causes bypassed their own reflection. A person shaped by upbringing can still examine and revise what they were taught. The manipulated agent, as the case is usually described, cannot.\n\nSo the line I would draw is between histories that leave a person able to review their own values and histories that do not. Determinism, on its own, does not put anyone on the wrong side of that line. That means",
            { status: "streaming", durationMs: undefined, usage: undefined, finishReason: undefined },
          ),
          reply(
            "B",
            "A has not answered the manipulation case. An agent whose values were set up by a neuroscientist responds to reasons just as well as anyone else, and yet we do not think they deserve blame. Until A explains the difference, responsiveness is not enough.",
            { durationMs: 7300 },
          ),
          reply("C", "", {
            status: "streaming",
            durationMs: undefined,
            usage: undefined,
            finishReason: undefined,
            tools: [tool("web_search", "Pereboom four-case manipulation argument", "running")],
          }),
          reply("D", "", { status: "queued", durationMs: undefined, usage: undefined, finishReason: undefined }),
        ],
        arbiterReplies: [
          reply(arbiter.id, "", { status: "queued", durationMs: undefined, usage: undefined, finishReason: undefined }),
        ],
      }),
    ],
    privateThreads: {},
  };
}

// ---------- a demo conversation, for the README screenshot ----------

// Two people are naming a small Mac app. Round 1 ran in parallel; round 2 ran
// in round robin, so each agent answers the ones before it. The host talked
// privately with Builder between the rounds.
const DEMO_SUMMARIZER: Arbiter = {
  id: "arbiter-1",
  name: SUMMARIZER_NAME,
  modelId: "cli/claude-code",
  modelName: "Claude Code",
  maker: "anthropic",
  browsing: false,
  toolModel: "haiku",
  instructions: SUMMARIZER_INSTRUCTIONS,
};

function demoFixture(): Table {
  const D0 = T0 + 86_400_000;
  const min = 60_000;
  const seats: Seat[] = [
    {
      id: "A",
      name: "Skeptic",
      color: "purple",
      modelId: "cli/claude-code",
      modelName: "Claude Code",
      maker: "anthropic",
      toolModel: "opus",
      browsing: true,
      instructions: "Find the weakest assumption in each idea, and say what evidence would settle it.",
    },
    {
      id: "B",
      name: "Builder",
      color: "teal",
      modelId: "cli/codex",
      modelName: "Codex",
      maker: "openai",
      toolModel: "gpt-6-astra",
      browsing: true,
    },
    { id: "C", color: "blue", modelId: "google/gemini-3.1-pro-preview", modelName: "Gemini 3.1 Pro Preview", maker: "google", browsing: true },
    { id: "D", color: "orange", modelId: "spacexai/grok-4.7", modelName: "Grok 4.7", maker: "xai", browsing: false },
  ];
  // A finished reply with its own timing and token counts.
  const said = (
    participantId: string,
    text: string,
    at: number,
    durationMs: number,
    inputTokens: number,
    outputTokens: number,
    extra: Partial<Reply> = {},
  ) => reply(participantId, text, { startedAt: at, durationMs, usage: { inputTokens, outputTokens }, ...extra });

  const r1At = D0;
  const r1 = round(1, {
    turns: "parallel",
    seats,
    arbiters: [DEMO_SUMMARIZER],
    host: host(
      "Which name says what the app does best: Margin, Shelf or Recall? We are two people building a Mac app that saves every article you read, with your highlights, into a private library you can search later. Launch is in six weeks. Pick a name, say who it is for in one line, and tell us what to leave out of the first version.",
      [],
      r1At,
    ),
    replies: [
      said(
        "A",
        "**Recall overpromises.** It tells people the app will remember things for them, and the first time a search misses, the name becomes the complaint. I would drop it.\n\nBetween the other two, Margin is the stronger name, as long as highlights are the heart of the product. It points at the habit of writing in the margins of a book, which describes the person most likely to pay. Shelf sounds calm, but it describes storage, and Safari's Reading List and a dozen free apps already give storage away.\n\nThe line I would test: *Everything you have read, with your notes, searchable on your Mac.*\n\nLeave sync out of the first version. It is the hardest feature to get right, and a local-only app is easier to trust.",
        r1At + 2_000,
        14_600,
        2_310,
        204,
      ),
      said(
        "B",
        "Shelf. It is short, easy to say, and it tells a new user what to do with the app: put things on it. Margin is clever, but people need the book reference before it makes sense, and most will first see the name in a list of search results with no context.\n\nFor the first version, I would ship three things and nothing else:\n\n1. A browser extension that saves the page and your highlights in one click.\n2. A library window with full-text search.\n3. Export to Markdown, so nobody feels locked in.\n\nLeave out tags, sharing and the iPhone app. Each is a reasonable request, and each would push the launch past six weeks.",
        r1At + 2_000,
        11_200,
        2_280,
        168,
      ),
      said(
        "C",
        "Recall describes the benefit most directly, so I would not dismiss it quickly. People rarely buy a place to put articles. They buy the moment, months later, when they find the quote they half remember.\n\nThe name has a cost, though. Recall is also the word for a product safety notice, and a Windows feature with the same name drew sharp criticism over privacy. For an app whose promise is a private library, that association is a real risk.\n\nSo my order is Margin, then Shelf, with Recall out. I would position it for researchers, writers and students who already highlight, because they feel this problem every week.",
        r1At + 2_000,
        9_800,
        2_250,
        151,
        { votes: 1 },
      ),
      said(
        "D",
        "I would not pick any of them yet. All three are common words, so the App Store search, the domain and the trademark will be crowded, and a small team cannot outspend that.\n\nTwo quick checks before you choose:\n\n- Search the Mac App Store for each name and count the apps already using it.\n- Ask ten people who would buy this which name they remember an hour later.\n\nIf you have to decide today, choose Margin. It is the only one of the three that hints at reading, and it leaves room for a distinctive icon.",
        r1At + 2_000,
        6_900,
        2_240,
        126,
      ),
    ],
    arbiterReplies: [
      said(
        DEMO_SUMMARIZER.id,
        "**The chat so far.** The host asked the agents to choose between Margin, Shelf and Recall for a Mac reading library, and to say what the first version should leave out.\n\n- **Skeptic** prefers Margin, rules out Recall as an overpromise, and would leave sync out of the first version.\n- **Builder** prefers Shelf as the plainest name and would ship only the extension, search and Markdown export.\n- **Gemini 3.1 Pro Preview** ranks Margin first and drops Recall because of its privacy associations.\n- **Grok 4.7** wants a quick App Store and memory test first, and would choose Margin if it had to decide today.",
        r1At + 17_000,
        4_300,
        3_420,
        132,
      ),
    ],
  });

  const r2At = D0 + 40 * min;
  const r2 = round(2, {
    turns: "roundRobin",
    seats,
    arbiters: [DEMO_SUMMARIZER],
    host: host(
      "We ran Grok's test: 7 of 10 people remembered Margin, 2 remembered Shelf and 1 remembered Recall. Agree on a name and a one-line pitch, and flag anything that should still stop us.",
      [],
      r2At,
    ),
    replies: [
      said(
        "A",
        "The test settles the name for me: Margin. Before you commit, there is one conflict worth checking.\n\nI searched the Mac App Store and found two apps with Margin in the name, a notes app and a PDF annotator. Both are small and neither has been updated this year, so they do not block you, but the plain word will be hard to rank for. Listing it as **Margin Reader** keeps the short brand and avoids the clash.\n\nFor the pitch, I would keep it concrete: *Save what you read, keep what you highlight, and find it again in seconds.*\n\nWhat would still stop me is a registered trademark for Margin in software. I did not find one, but a lawyer should spend an hour on it before you buy the domain.",
        r2At + 2_000,
        21_400,
        4_960,
        186,
        {
          votes: 1,
          tools: [
            tool("web_search", "Margin app Mac App Store", "done", "8 results"),
            tool("web_search", "Margin trademark software USPTO", "done", "6 results"),
            tool("read_page", "https://apps.apple.com/us/search?term=margin", "done", "Read 1,100 words"),
          ],
        },
      ),
      said(
        "B",
        "I am switching to Margin. I asked for evidence that people remember it, and seven out of ten is a clear answer.\n\nI agree with Skeptic on **Margin Reader** for the store listing. It reads well in a search result and tells people what kind of app it is before they tap.\n\nSkeptic's pitch is good, but it is too long for the App Store subtitle, which allows 30 characters. I would use *Your reading, searchable.* there and keep the longer line for the website.\n\nThe scope stays the same: the extension, the library with search, and Markdown export, in six weeks.",
        r2At + 24_000,
        12_300,
        5_380,
        142,
        { votes: 2 },
      ),
      said(
        "C",
        "Margin Reader works, and I agree with both earlier replies on the store name.\n\nI would push back a little on Builder's subtitle. Search is a feature every competitor claims, and the test suggests people remember Margin because it brings notes to mind. I would keep *Your reading, searchable.* for the App Store, where space is short, and lead the website with this:\n\n*Your highlights and notes, all in one place.*\n\nOn what could still stop you: check that a domain such as **margin.app** is available before you announce. If the only domains left are awkward, that is a better reason to revisit the name than anything raised so far.",
        r2At + 37_000,
        10_600,
        5_720,
        148,
      ),
      said(
        "D",
        "Margin Reader it is. The test was small, but a split of seven to two is decisive enough.\n\nMy one disagreement is with leaving sync out entirely. People who read on a phone and a laptop will save something on one and look for it on the other in the first week. I would still keep it out of the launch, but I would say on the website that sync is coming, so people know the gap is planned.\n\nEverything else here has my support: the name, Builder's subtitle, and the narrow scope.",
        r2At + 48_000,
        7_400,
        6_050,
        112,
      ),
    ],
    arbiterReplies: [
      said(
        DEMO_SUMMARIZER.id,
        "**The chat so far.** After a ten-person test favored Margin, every agent now backs the name, with Margin Reader as the App Store listing.\n\n- **Skeptic** found two small Margin apps in the store and wants an hour of trademark review before you buy the domain.\n- **Builder** switched to Margin and proposed *Your reading, searchable.* to fit the 30 character subtitle.\n- **Gemini 3.1 Pro Preview** keeps that subtitle for the store but would lead the website with highlights and notes, after confirming a domain.\n- **Grok 4.7** agrees on the name and scope, and wants the website to say that sync is coming.",
        r2At + 56_000,
        4_900,
        6_880,
        138,
      ),
    ],
  });

  const pmAt = D0 + 20 * min;
  const privately = (role: PrivateMessage["role"], text: string, at: number, durationMs?: number, usage?: PrivateMessage["usage"]) => ({
    ...pm(role, text, 1, durationMs),
    createdAt: at,
    ...(usage ? { usage, startedAt: at } : {}),
  });

  return {
    id: "preview-demo",
    title: "Which name says what the app does…",
    createdAt: D0,
    updatedAt: r2At + 61_000,
    interaction: "group",
    turns: "roundRobin",
    instructions:
      "You are advising a two-person team. Keep each reply under 150 words, and say plainly when you disagree with another agent.",
    seats,
    arbiters: [DEMO_SUMMARIZER],
    rounds: [r1, r2],
    privateThreads: {
      B: [
        privately("host", "You are the only one backing Shelf. What would it take for you to switch to Margin?", pmAt),
        privately(
          "seat",
          "Evidence that people get it without help. If most of the people in Grok's test remember Margin and can say what the app does, I would switch. The name matters less than the first screen, so whichever we pick, the empty library should say in one sentence what to save first.",
          pmAt + 3_000,
          6_200,
          { inputTokens: 3_610, outputTokens: 74 },
        ),
        privately("host", "Fair. Suppose the test favors Margin.", pmAt + 90_000),
        privately(
          "seat",
          "Then Margin, and I will say so in the next round. I would still keep the launch to the extension, search and export.",
          pmAt + 93_000,
          4_100,
          { inputTokens: 3_720, outputTokens: 38 },
        ),
      ],
    },
    threadPrivacy: { B: "shared" },
  };
}

const builders: Record<FixtureName, () => Table> = {
  new: newFixture,
  group: groupFixture,
  independent: independentFixture,
  running: runningFixture,
  demo: demoFixture,
};

// ---------- a store for previews ----------

// Holds a fixture table. Edits, votes, privacy switches and rewinds of rounds and side
// conversations apply, so the controls can be tried. Sending and stopping do nothing,
// because there is no engine behind it.
function previewStore(table: Table): TableStore {
  let current = table;
  const listeners = new Set<() => void>();
  const publish = (next: Table) => {
    current = next;
    listeners.forEach((l) => l());
  };
  return {
    getTable: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isBusy: () => isBusy(current),
    sendRound: async () => {},
    sendPrivate: async () => {},
    stop: () => {},
    edit(edit: TableEdit) {
      if (isBusy(current)) return;
      publish({ ...current, ...edit, updatedAt: Date.now() });
    },
    setThreadPrivacy(participantId: string, privacy: ThreadPrivacy) {
      publish({ ...current, threadPrivacy: { ...current.threadPrivacy, [participantId]: privacy }, updatedAt: Date.now() });
    },
    vote(replyId: string, delta: number) {
      const bump = (r: Reply) => (r.id === replyId ? { ...r, votes: (r.votes ?? 0) + delta } : r);
      publish({
        ...current,
        rounds: current.rounds.map((r) => ({ ...r, replies: r.replies.map(bump), arbiterReplies: r.arbiterReplies.map(bump) })),
      });
    },
    rewind(roundNumber: number): HostMessage | null {
      const target = current.rounds.find((r) => r.number === roundNumber);
      if (!target || isBusy(current)) return null;
      const privateThreads: Table["privateThreads"] = {};
      for (const [id, thread] of Object.entries(current.privateThreads)) {
        const kept = thread?.filter((m) => m.afterRound < roundNumber) ?? [];
        if (kept.length) privateThreads[id] = kept;
      }
      publish({
        ...current,
        rounds: current.rounds.filter((r) => r.number < roundNumber),
        privateThreads,
        updatedAt: Date.now(),
      });
      return target.host;
    },
    rewindPrivate(participantId: string, messageId: string): PrivateMessage | null {
      const thread = current.privateThreads[participantId] ?? [];
      const index = thread.findIndex((m) => m.id === messageId);
      const target = thread[index];
      if (!target || target.role !== "host" || isBusy(current)) return null;
      const privateThreads = { ...current.privateThreads };
      if (index > 0) privateThreads[participantId] = thread.slice(0, index);
      else delete privateThreads[participantId];
      publish({ ...current, privateThreads, updatedAt: Date.now() });
      return target;
    },
  };
}

const previews = new Map<FixtureName, TableStore>();

export function previewTable(name: FixtureName): TableStore {
  let store = previews.get(name);
  if (!store) {
    store = previewStore(builders[name]());
    previews.set(name, store);
  }
  return store;
}

export function isFixtureName(name: string | undefined): name is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(name ?? "");
}

// ---------- screenshot mode ----------

// `npm run screenshot` opens /?screenshot=1#/preview/demo. In that mode the
// sidebar lists a few made-up conversations in place of the ones saved on
// this machine, and the thread starts at the top, where the collapsed round 1
// sits above round 2, in place of the newest reply.
const SCREENSHOT_RECENT: Array<[title: string, hoursAgo: number]> = [
  ["How should we price the annual plan…", 3],
  ["Draft the launch post for the Mac…", 26],
  ["Review the onboarding copy for the…", 70],
  ["Is a local-first app easier to…", 150],
];

function startScreenshotMode() {
  const now = Date.now();
  const tables = SCREENSHOT_RECENT.map(([title, hoursAgo], i) => {
    const at = now - hoursAgo * 3_600_000;
    return { id: `screenshot-${i + 1}`, title, createdAt: at, updatedAt: at };
  });
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "GET" && new URL(url, window.location.href).pathname === "/api/conversations") {
      return Promise.resolve(Response.json({ tables }));
    }
    return realFetch(input, init);
  };
  // The thread keeps itself at the newest reply as it renders, so the scroll
  // is set again until the page has settled.
  const toTop = () => {
    const thread = document.querySelector(".thread-scroll");
    if (thread) thread.scrollTop = 0;
  };
  for (const ms of [600, 1500, 3000]) setTimeout(toTop, ms);
}

if (
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("screenshot") &&
  window.location.hash === "#/preview/demo"
) {
  // The sample-mode note would be wrong in a picture of the app.
  document.documentElement.dataset.screenshot = "1";
  startScreenshotMode();
}
