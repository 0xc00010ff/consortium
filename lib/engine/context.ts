// What the models read (spec section 5). Pure functions that turn a Table
// into a SpeakRequest for a seat in a round, an arbiter in a round, or a
// private reply from a seat or an arbiter.
//
// Every request has one instructions string and one user message. The user
// message holds the transcript as markdown, then the images in the order they
// are numbered in the transcript, then a short "Now" section. The transcript
// comes first so the start of the message stays the same as the table grows,
// which helps prompt caching.
//
// Which replies a seat reads follows the Interaction setting of the round
// being answered, applied to the whole transcript. A table switched to Group
// lets the seats read each other's earlier replies from then on.
//
// The Turns setting of the round decides how a seat reads the current round.
// In a parallel round it reads none of it, and the host's message goes in the
// "Now" section. In a round robin round the seats answer one after another,
// so the current round is in the transcript with the replies given so far.

import type {
  Arbiter,
  Attachment,
  HostMessage,
  Interaction,
  PrivateMessage,
  Reply,
  Round,
  Seat,
  SeatId,
  SpeakRequest,
  Table,
  Turns,
} from "@/lib/types";
import { SEAT_LETTERS } from "@/lib/types";

export const ROUND_MAX_OUTPUT_TOKENS = 8000;
export const PRIVATE_MAX_OUTPUT_TOKENS = 4000;

export const TRANSCRIPT_HEADING = "# Transcript";
export const NOW_HEADING = "# Now";

const REPLY_FORMAT = "Reply in plain text or markdown. Keep replies to about 200 words unless the host asks for more.";
const BROWSING =
  "You can use the web_search tool to search the web and the read_page tool to read a page by its URL, when current facts or sources would help your reply.";
// Said only once the host has voted on something, so a table without votes
// never mentions them.
const VOTES =
  'The host votes replies up or down to reward the ones they found most useful, and can vote on a reply more than once. A reply with votes shows its score under it in the transcript, such as "Host votes: +2".';

// ---------- Requests ----------

// The request for one seat in the current round, the last round of the table.
// In a parallel round it leaves out every reply from the current round, and
// the host's message for this round goes in the "Now" section. In a round
// robin round the current round is in the transcript with the replies given
// before this seat's turn, and the "Now" section says it is this seat's turn.
export function buildSeatRequest(table: Table, seatId: SeatId): SpeakRequest {
  const round = currentRound(table);
  const seats = round.seats ?? table.seats;
  const seat = findSeat(seats, seatId) ?? findSeat(table.seats, seatId);
  if (!seat) throw new Error(`Agent ${seatId} is not at this table.`);
  const turns = round.turns ?? "parallel";

  const images: Attachment[] = [];
  const viewer: Viewer = { kind: "seat", seatId, interaction: round.interaction, turns };
  const transcript = renderTranscript(table, viewer, round.number, images);
  let now: string[];
  if (turns === "roundRobin") {
    now = turnNow(round, seatId, round.interaction === "group", labeler(round.seats, table.seats));
  } else {
    now = roundNow(round, images.length + 1, sitOut(round, "sit"));
    images.push(...round.host.attachments);
  }
  if (images.length > 0) now.push(IMAGES_ABOVE);

  return {
    modelId: seat.modelId,
    ...(seat.toolModel ? { toolModel: seat.toolModel } : {}),
    instructions: seatInstructions(table, seats, seat, round.interaction, turns),
    messages: [userMessage(transcript, images, now)],
    browsing: seat.browsing,
    maxOutputTokens: ROUND_MAX_OUTPUT_TOKENS,
    mockHint: { purpose: "seat", interaction: round.interaction, round: round.number, seatId },
  };
}

// The request for one arbiter in the current round. It includes this round's
// seat replies and the replies of the arbiters before it, and this arbiter's
// own private conversation with the host. It never includes anyone else's.
export function buildArbiterRequest(table: Table, arbiterId: string): SpeakRequest {
  const round = currentRound(table);
  const arbiters = round.arbiters ?? table.arbiters;
  const arbiter = arbiters.find((a) => a.id === arbiterId) ?? table.arbiters.find((a) => a.id === arbiterId);
  if (!arbiter) throw new Error(`The arbiter ${arbiterId} is not at this table.`);

  const images: Attachment[] = [];
  const transcript = renderTranscript(table, { kind: "arbiter", arbiterId }, round.number, images);
  const seatsAnswered = round.replies.some((r) => r.status === "done");
  const position = round.arbiterReplies.findIndex((r) => r.participantId === arbiterId);
  const earlierArbiters = round.arbiterReplies.some((r, i) => r.status === "done" && (position < 0 || i < position));
  let answered = seatsAnswered
    ? "The agents have answered the host."
    : "No agent finished a reply in this round.";
  if (earlierArbiters) answered += " The arbiters before you have also replied.";
  const start = [`Round ${round.number}.`, sitOut(round, "sat"), answered].filter(Boolean).join(" ");
  const now = [`${start} Write your reply as ${arbiter.name}, following the host's instructions.`];
  if (images.length > 0) now.push(IMAGES_ABOVE);

  return {
    modelId: arbiter.modelId,
    ...(arbiter.toolModel ? { toolModel: arbiter.toolModel } : {}),
    instructions: arbiterInstructions(table, round, arbiter),
    messages: [userMessage(transcript, images, now)],
    browsing: arbiter.browsing,
    maxOutputTokens: ROUND_MAX_OUTPUT_TOKENS,
    mockHint: { purpose: "arbiter", interaction: round.interaction, round: round.number, arbiterName: arbiter.name },
  };
}

// The request for a reply in a private conversation with the host, from an
// agent (by letter) or an arbiter (by id). The conversation, including the
// host's latest message, is in the transcript after the round it followed.
export function buildPrivateRequest(table: Table, participantId: string): SpeakRequest {
  const arbiter = table.arbiters.find((a) => a.id === participantId);
  if (arbiter) return buildArbiterPrivateRequest(table, arbiter);
  const seatId = participantId as SeatId;
  const seat = findSeat(table.seats, seatId);
  if (!seat) {
    const isLetter = (SEAT_LETTERS as readonly string[]).includes(participantId);
    throw new Error(isLetter ? `Agent ${participantId} is not at this table.` : `The arbiter ${participantId} is not at this table.`);
  }
  const last = table.rounds[table.rounds.length - 1];
  const interaction = last?.interaction ?? table.interaction;
  const turns = last?.turns ?? "parallel";

  const images: Attachment[] = [];
  const transcript = renderTranscript(table, { kind: "seat", seatId, interaction, turns }, null, images);
  const now = [
    "The host is now talking with you privately. The other agents and the arbiters do not see this. Reply to the host's last message.",
  ];
  if (images.length > 0) now.push(IMAGES_ABOVE);

  return {
    modelId: seat.modelId,
    ...(seat.toolModel ? { toolModel: seat.toolModel } : {}),
    instructions: seatInstructions(table, last?.seats ?? table.seats, seat, interaction, turns),
    messages: [userMessage(transcript, images, now)],
    browsing: seat.browsing,
    maxOutputTokens: PRIVATE_MAX_OUTPUT_TOKENS,
    mockHint: { purpose: "private", interaction, round: table.rounds.length, seatId },
  };
}

// An arbiter's private reply. It reads everything, as in a round, with its
// own private conversation placed after the rounds it followed.
function buildArbiterPrivateRequest(table: Table, arbiter: Arbiter): SpeakRequest {
  const last = table.rounds[table.rounds.length - 1];
  const interaction = last?.interaction ?? table.interaction;

  const images: Attachment[] = [];
  const transcript = renderTranscript(table, { kind: "arbiter", arbiterId: arbiter.id }, null, images);
  const others = table.arbiters.length > 1 ? "The agents and the other arbiters do not see this." : "The agents do not see this.";
  const now = [`The host is now talking with you privately. ${others} Reply to the host's last message.`];
  if (images.length > 0) now.push(IMAGES_ABOVE);

  return {
    modelId: arbiter.modelId,
    ...(arbiter.toolModel ? { toolModel: arbiter.toolModel } : {}),
    instructions: arbiterInstructions(table, last, arbiter),
    messages: [userMessage(transcript, images, now)],
    browsing: arbiter.browsing,
    maxOutputTokens: PRIVATE_MAX_OUTPUT_TOKENS,
    mockHint: { purpose: "private", interaction, round: table.rounds.length, arbiterName: arbiter.name },
  };
}

function currentRound(table: Table): Round {
  const round = table.rounds[table.rounds.length - 1];
  if (!round) throw new Error("The table has no round to answer yet.");
  return round;
}

function findSeat(seats: Seat[], seatId: SeatId): Seat | undefined {
  return seats.find((s) => s.id === seatId);
}

// The letters of the agents that are on, in speaking order.
function speakingOrder(seats: Seat[]): SeatId[] {
  return seats.filter((s) => s.active !== false).map((s) => s.id);
}

function userMessage(transcript: string, images: Attachment[], now: string[]) {
  return {
    role: "user" as const,
    text: transcript,
    ...(images.length > 0 ? { attachments: images } : {}),
    afterAttachments: `${NOW_HEADING}\n\n${now.join("\n\n")}`,
  };
}

// ---------- Instructions ----------

// `seats` decides who is at the table and the speaking order. Names come from
// the table as it is now, so a name the host just gave reaches the next request.
function seatInstructions(table: Table, seats: Seat[], seat: Seat, interaction: Interaction, turns: Turns): string {
  const label = labeler(table.seats, seats);
  const others = seats.map((s) => s.id).filter((id) => id !== seat.id);
  const parts: string[] = [];
  parts.push(
    others.length > 0
      ? `You are Agent ${label(seat.id)} at a table with ${others.length === 1 ? "agent" : "agents"} ${listWords(others.map(label))}.`
      : `You are Agent ${label(seat.id)}, the only agent at the table.`,
  );
  const ownName = agentName(findSeat(table.seats, seat.id) ?? seat);
  if (ownName) parts.push(`The host calls you ${ownName}.`);
  parts.push("Each agent is an AI model. The host is the person who runs the table and speaks to it between rounds.");
  if (others.length > 0) {
    if (turns === "roundRobin") {
      const order = speakingOrder(seats);
      if (order.length > 1) {
        parts.push(`In each round, the agents answer one after another, in the order ${order.map(label).join(", ")}.`);
        if (interaction === "group") parts.push(turnPosition(order, seat.id, label));
      }
    } else {
      parts.push(
        "In each round, every agent answers at the same time, so you do not see the other agents' replies from the current round.",
      );
    }
  }
  const hasArbiters = table.arbiters.length > 0 || table.rounds.some((r) => r.arbiterReplies.some((a) => a.status === "done"));
  if (interaction === "group" && (others.length > 0 || hasArbiters)) {
    if (hasArbiters) {
      parts.push(
        "The table also has arbiters, which are AI models that answer after the agents and follow their own instructions from the host.",
      );
      parts.push("You can read the other agents' replies and the arbiters' replies from earlier rounds.");
    } else {
      parts.push("You can read the other agents' replies from earlier rounds.");
    }
    parts.push("Respond to specific points when it helps, and say when you disagree. Do not repeat what others have already said.");
  } else if (interaction === "independent") {
    parts.push("You cannot read the other agents. Answer the host directly.");
  }
  if (hasVotes(table)) parts.push(VOTES);
  parts.push(REPLY_FORMAT);
  if (seat.browsing) parts.push(BROWSING);
  return [parts.join(" "), ...hostInstructions(table, seat)].join("\n\n");
}

// Where a seat speaks in a round robin round of a Group table, and what that
// lets it read.
function turnPosition(order: SeatId[], seatId: SeatId, label: Labeler): string {
  const index = order.indexOf(seatId);
  if (index < 0) return "Each agent can read the replies given before its turn in the current round.";
  const after = order.length - index - 1;
  const readers = after === 1 ? "the agent after you" : "the agents after you";
  if (index === 0) return `You answer first, and ${readers} will read your reply.`;
  const previous = `Agent ${label(order[index - 1])}`;
  if (after === 0) return `You answer last, after ${previous}. You can read the replies given before yours in the current round.`;
  return `You answer after ${previous}. You can read the replies given before yours in the current round, and ${readers} will read your reply.`;
}

// The host's prompts, as paragraphs after the standing instructions.
function hostInstructions(table: Table, seat?: Seat): string[] {
  const out: string[] = [];
  const all = table.instructions?.trim();
  const own = seat?.instructions?.trim();
  if (all) out.push(`The host gave these instructions to every agent:\n\n${all}`);
  if (own) out.push(`The host gave these instructions to you. The other agents do not see them.\n\n${own}`);
  return out;
}

function hasVotes(table: Table): boolean {
  return table.rounds.some((r) => [...r.replies, ...r.arbiterReplies].some((reply) => (reply.votes ?? 0) !== 0));
}

// "Host votes: +2" or "Host votes: -1", for a reply the host voted on.
export function votesLine(reply: Reply): string | null {
  const votes = reply.votes ?? 0;
  if (votes === 0) return null;
  return `Host votes: ${votes > 0 ? "+" : ""}${votes}`;
}

// `round` is the round being answered, or for a private reply the last round,
// which is absent before round 1.
function arbiterInstructions(table: Table, round: Round | undefined, arbiter: Arbiter): string {
  const label = labeler(table.seats, round?.seats);
  const seats = (round?.seats ?? table.seats).map((s) => label(s.id));
  const order = speakingOrder(round?.seats ?? table.seats).map(label);
  const arbiters = round?.arbiters ?? table.arbiters;
  const readers = arbiters.length > 1 ? "the host, the agents and the other arbiters" : "the host and the agents";
  const intro = [
    `You are an arbiter named ${arbiter.name} at a table of AI models.`,
    seats.length > 0 ? `The agents are called ${listWords(seats)}.` : "",
    round?.turns === "roundRobin" && order.length > 1
      ? `The host runs the table. In each round, the agents answer one after another, in the order ${order.join(", ")}, and then you answer.`
      : "The host runs the table. In each round, the agents answer first, and then you answer.",
    `You can read everything ${readers} have said.`,
    hasVotes(table) ? VOTES : "",
  ]
    .filter(Boolean)
    .join(" ");
  const own = arbiter.instructions.trim();
  const rules = own
    ? `Follow these instructions from the host:\n\n${own}`
    : "The host has not given you instructions yet. Keep a short numbered summary of the main points each agent made, and note where the agents agree and where they differ.";
  const format = arbiter.browsing ? `${REPLY_FORMAT} ${BROWSING}` : REPLY_FORMAT;
  return [`${intro} ${rules}`, ...hostInstructions(table), format].join("\n\n");
}

// ---------- Transcript ----------

type Viewer = { kind: "seat"; seatId: SeatId; interaction: Interaction; turns: Turns } | { kind: "arbiter"; arbiterId: string };

// Renders the table for one reader. `current` is the number of the round being
// answered, or null for a private reply. Images are added to `images` in the
// order they are numbered.
function renderTranscript(table: Table, viewer: Viewer, current: number | null, images: Attachment[]): string {
  const out: string[] = [];
  // The reader's own private conversation, and no one else's.
  const privateGroups = new Map<number, PrivateMessage[]>();
  const ownId = viewer.kind === "seat" ? viewer.seatId : viewer.arbiterId;
  for (const message of table.privateThreads[ownId] ?? []) {
    const group = privateGroups.get(message.afterRound) ?? [];
    group.push(message);
    privateGroups.set(message.afterRound, group);
  }
  const renderPrivate = (afterRound: number) => {
    const group = privateGroups.get(afterRound);
    privateGroups.delete(afterRound);
    if (group) out.push(...privateBlock(afterRound, group, images));
  };

  renderPrivate(0);
  for (const round of table.rounds) {
    const isCurrent = round.number === current;
    // In a parallel round, a seat reads its own round's message in the "Now"
    // section. In a round robin round it reads the round so far, which holds
    // only the replies given before its turn.
    if (isCurrent && viewer.kind === "seat" && viewer.turns !== "roundRobin") continue;

    out.push(`## Round ${round.number}`);
    out.push("### Host", hostBody(round.host, images));
    const absent = sitOut(round, isCurrent && viewer.kind === "seat" ? "sit" : "sat");
    if (absent) out.push(`*${absent}*`);

    for (const reply of round.replies) {
      if (reply.status !== "done") continue;
      const letter = reply.participantId;
      const seat = round.seats?.find((s) => s.id === letter) ?? table.seats.find((s) => s.id === letter);
      const you = viewer.kind === "seat" && letter === viewer.seatId;
      if (viewer.kind === "seat" && !you && viewer.interaction !== "group") continue;
      out.push(agentHeading(letter, seat, you), ...replyBody(reply));
    }

    const ownIndex = viewer.kind === "arbiter" ? round.arbiterReplies.findIndex((r) => r.participantId === viewer.arbiterId) : -1;
    round.arbiterReplies.forEach((reply, index) => {
      if (reply.status !== "done") return;
      if (viewer.kind === "seat" && viewer.interaction !== "group") return;
      if (viewer.kind === "arbiter" && isCurrent && ownIndex >= 0 && index >= ownIndex) return;
      const name = arbiterName(table, round, reply.participantId);
      const you = viewer.kind === "arbiter" && reply.participantId === viewer.arbiterId;
      out.push(`### ${name} (${you ? "arbiter, you" : "arbiter"})`, ...replyBody(reply));
    });

    renderPrivate(round.number);
  }
  // Anything left belongs after the last round shown.
  for (const afterRound of [...privateGroups.keys()].sort((a, b) => a - b)) renderPrivate(afterRound);

  return out.length > 0 ? `${TRANSCRIPT_HEADING}\n\n${out.join("\n\n")}` : "";
}

// A reply's text, then its votes when the host voted on it.
function replyBody(reply: Reply): string[] {
  const votes = votesLine(reply);
  return votes ? [reply.text.trim(), `*${votes}*`] : [reply.text.trim()];
}

function privateBlock(afterRound: number, messages: PrivateMessage[], images: Attachment[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.status !== "done") continue;
    if (message.role === "host") {
      lines.push(`**Host:** ${message.text.trim() || "(no text)"}`);
      const attachments = message.attachments ?? [];
      if (attachments.length > 0) {
        lines.push(`*The host attached ${imageList(images.length + 1, attachments)}.*`);
        images.push(...attachments);
      }
    } else {
      lines.push(`**You:** ${message.text.trim()}`);
    }
  }
  if (lines.length === 0) return [];
  const when = afterRound > 0 ? `after round ${afterRound}` : "before round 1";
  return [`### Private conversation between the host and you, ${when}`, ...lines];
}

function hostBody(host: HostMessage, images: Attachment[]): string {
  const parts = [host.text.trim() || "The host added no note."];
  if (host.attachments.length > 0) {
    parts.push(`*The host attached ${imageList(images.length + 1, host.attachments)}.*`);
    images.push(...host.attachments);
  }
  return parts.join("\n\n");
}

// The "Now" section for a seat in a round. `firstImage` is the number the
// first image of this message gets. `absent` names the agents that sit out.
function roundNow(round: Round, firstImage: number, absent: string): string[] {
  const text = round.host.text.trim();
  const attachments = round.host.attachments;
  const start = absent ? `Round ${round.number}. ${absent}` : `Round ${round.number}.`;
  if (text) {
    const now = [`${start} The host wrote:\n\n${text}`];
    if (attachments.length > 0) now.push(`The host attached ${imageList(firstImage, attachments)} to this message.`);
    return now;
  }
  if (attachments.length > 0) {
    const one = attachments.length === 1;
    const what = one ? "an image" : "images";
    const noun = one ? "image" : "images";
    const numbered = `${one ? "It is" : "They are"} ${imageList(firstImage, attachments)}.`;
    return round.number <= 1
      ? [`${start} The host attached ${what} and wrote no text. Respond to the ${noun}. ${numbered}`]
      : [
          `${start} The host attached ${what} and added no note. ${numbered} Continue from where the table left off, and take the ${noun} into account.`,
        ];
  }
  return round.number <= 1
    ? [`${start} The host sent an empty message. Ask the host what they would like to discuss.`]
    : [`${start} The host added no note. Continue from where the table left off.`];
}

// The "Now" section for a seat in a round robin round. The host's message and
// its images are in the transcript, so this says only whose turn it is and
// what to reply to. In a Group table it names the agents that have replied
// before this seat.
function turnNow(round: Round, seatId: SeatId, readsOthers: boolean, label: Labeler): string[] {
  const index = round.replies.findIndex((r) => r.participantId === seatId);
  const before = round.replies.slice(0, Math.max(index, 0)).filter((r) => r.status === "done");
  const shown = readsOthers ? before.map((r) => label(r.participantId)) : [];
  const who = shown.length > 0 ? `${shown.length === 1 ? "Agent" : "Agents"} ${listWords(shown)}` : "";
  const position =
    index === 0
      ? "You answer first this round."
      : who
        ? `It is your turn. ${who} ${shown.length === 1 ? "has" : "have"} already replied this round.`
        : "It is your turn.";
  const respond = who ? `, and respond to ${who} where it helps` : "";

  const attachments = round.host.attachments;
  let task: string;
  if (round.host.text.trim()) {
    task = `Reply to the host's message${respond}.`;
  } else if (attachments.length > 0) {
    const one = attachments.length === 1;
    const what = one ? "an image" : "images";
    const noun = one ? "image" : "images";
    task =
      round.number <= 1
        ? `The host attached ${what} and wrote no text. Respond to the ${noun}${who ? `, and to ${who} where it helps` : ""}.`
        : `The host attached ${what} and added no note. Continue from where the table left off, and take the ${noun} into account.${who ? ` Respond to ${who} where it helps.` : ""}`;
  } else {
    task =
      round.number <= 1
        ? "The host sent an empty message. Ask the host what they would like to discuss."
        : `The host added no note. Continue from where the table left off${respond}.`;
  }
  return [`Round ${round.number}. ${position} ${task}`];
}

// "Agents B and D sit out this round." or "Agent B sat out this round.", for
// the agents the host had turned off when the round started. Empty when every
// agent took part. A round saved without its seats predates turning agents
// off, so nobody sat it out.
export function sitOut(round: Round, verb: "sit" | "sat"): string {
  const off = (round.seats ?? []).filter((s) => s.active === false).map((s) => letterLabel(s.id, s));
  if (off.length === 0) return "";
  const one = off.length === 1;
  const word = verb === "sat" ? "sat" : one ? "sits" : "sit";
  return `${one ? "Agent" : "Agents"} ${listWords(off)} ${word} out this round.`;
}

function arbiterName(table: Table, round: Round, arbiterId: string): string {
  return (
    round.arbiters?.find((a) => a.id === arbiterId)?.name ??
    table.arbiters.find((a) => a.id === arbiterId)?.name ??
    "Arbiter"
  );
}

// ---------- Agent names ----------

// The models know each agent by its letter. When the host has named an agent,
// the name follows the letter in parentheses: "Agent A (Skeptic)" in a
// sentence, "A (Skeptic)" in a list, and "### Agent A (Skeptic)" or
// "### Agent A (Skeptic, you)" as a transcript heading.

type Labeler = (id: string) => string;

// The host's name for an agent, on one line, or null when it has none. A name
// is host text, so line breaks become spaces to keep the markdown intact.
export function agentName(seat: Pick<Seat, "name"> | undefined): string | null {
  const name = seat?.name?.replace(/\s+/g, " ").trim();
  return name || null;
}

// "Agent A (Skeptic)", or "Agent A" for an agent the host has not named.
export function agentLabel(seat: Pick<Seat, "id" | "name">): string {
  return `Agent ${letterLabel(seat.id, seat)}`;
}

// "A (Skeptic)" or "A", for lists and for use after "Agent" or "agents".
function letterLabel(id: string, seat: Pick<Seat, "name"> | undefined): string {
  const name = agentName(seat);
  return name ? `${id} (${name})` : id;
}

// Labels agents by letter and name, taking each seat from the first list that
// has it.
function labeler(...lists: Array<Seat[] | undefined>): Labeler {
  return (id) => {
    for (const seats of lists) {
      const seat = seats?.find((s) => s.id === id);
      if (seat) return letterLabel(id, seat);
    }
    return id;
  };
}

// "### Agent A (Skeptic)", "### Agent B (Optimist, you)" or "### Agent C (you)".
function agentHeading(id: string, seat: Seat | undefined, you: boolean): string {
  const notes = [agentName(seat), you ? "you" : null].filter(Boolean);
  return notes.length > 0 ? `### Agent ${id} (${notes.join(", ")})` : `### Agent ${id}`;
}

// ---------- Wording ----------

const IMAGES_ABOVE = "The images appear above this section, in the order they are numbered.";

// "image 3 (chart.png)" or "images 3 and 4 (chart.png, photo.jpg)".
function imageList(first: number, attachments: Attachment[]): string {
  const names = attachments.map((a) => a.name || "image").join(", ");
  if (attachments.length === 1) return `image ${first} (${names})`;
  const numbers = attachments.map((_, i) => String(first + i));
  return `images ${listWords(numbers)} (${names})`;
}

export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
