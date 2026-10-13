// Markdown export of a table: the title, a short list of who took part, each
// round with the host message and every reply, and each private conversation,
// with an agent or an arbiter, under the round it followed.

import type { Arbiter, Attachment, PrivateMessage, Reply, Round, Seat, Table, ToolActivity } from "@/lib/types";
import { MAKER_LABELS, SEAT_LETTERS } from "@/lib/types";
import { agentName, sitOut, votesLine } from "./context";

export function tableToMarkdown(table: Table): string {
  const out: string[] = [];
  out.push(`# ${table.title.trim() || "Untitled table"}`);

  const facts = [
    `- Interaction: ${modeLabel(table)}`,
    `- Agents: ${table.seats.map(seatLine).join("; ") || "none"}`,
  ];
  if (table.arbiters.length > 0) facts.push(`- Arbiters: ${table.arbiters.map(arbiterLine).join("; ")}`);
  facts.push(`- Started: ${formatDate(table.createdAt)}`);
  out.push(facts.join("\n"));

  const instructions = table.instructions?.trim();
  if (instructions) out.push("**Instructions to every agent:**", instructions);
  for (const seat of table.seats) {
    const own = seat.instructions?.trim();
    if (own) out.push(`**Instructions to Agent ${seat.id}:**`, own);
  }

  const threads = privateConversations(table);
  const pushPrivate = (afterRound: number) => {
    for (const [participantId, messages] of threads.get(afterRound) ?? []) {
      out.push(...privateBlock(table, participantId, messages, afterRound));
    }
    threads.delete(afterRound);
  };

  pushPrivate(0);
  let previous: Round | null = null;
  for (const round of table.rounds) {
    out.push(`## Round ${round.number}`);
    const notes: string[] = [];
    if (previous && modeLabel(previous) !== modeLabel(round)) {
      notes.push(`*Interaction changed to ${modeLabel(round)} for this round.*`);
    }
    if (round.status === "stopped") notes.push("*This round was stopped.*");
    if (notes.length > 0) out.push(notes.join("\n"));

    out.push("### Host");
    out.push(round.host.text.trim() || "*No note.*");
    const attachments = attachmentLine(round.host.attachments);
    if (attachments) out.push(attachments);
    const absent = sitOut(round, "sat");
    if (absent) out.push(`*${absent}*`);

    for (const reply of round.replies) out.push(...replyBlock(reply, seatHeading(table, round, reply.participantId)));
    for (const reply of round.arbiterReplies) out.push(...replyBlock(reply, arbiterHeading(table, round, reply.participantId)));

    pushPrivate(round.number);
    previous = round;
  }
  for (const afterRound of [...threads.keys()].sort((a, b) => a - b)) pushPrivate(afterRound);

  return `${out.join("\n\n")}\n`;
}

// ---------- Blocks ----------

function replyBlock(reply: Reply, heading: string): string[] {
  const parts = [heading];
  if (reply.text.trim()) parts.push(reply.text.trim());
  const notes = [replyNotes(reply), votesLine(reply) && `*${votesLine(reply)}*`].filter(Boolean);
  if (notes.length > 0) parts.push(notes.join("\n"));
  return parts;
}

// Tool activity, and a note when the reply did not finish.
function replyNotes(reply: Reply | PrivateMessage): string | null {
  const notes: string[] = [];
  const tools = toolsLine(reply.tools);
  if (tools) notes.push(tools);
  if (reply.status === "error") notes.push(`*This reply did not finish: ${withPeriod(reply.error ?? "unknown error")}*`);
  else if (reply.status !== "done") notes.push("*This reply did not finish.*");
  return notes.length > 0 ? notes.join("\n") : null;
}

// A private conversation with an agent, headed "with Agent B", or with an
// arbiter, headed "with Tracker".
function privateBlock(table: Table, participantId: string, messages: PrivateMessage[], afterRound: number): string[] {
  const when = afterRound > 0 ? `after round ${afterRound}` : "before round 1";
  const { who, speaker } = privateNames(table, participantId);
  const out = [`### Private conversation with ${who}, ${when}`];
  for (const message of messages) {
    if (message.role === "host") {
      const lines = [`**Host:** ${message.text.trim() || "*No text.*"}`];
      const attachments = attachmentLine(message.attachments ?? []);
      if (attachments) lines.push(attachments);
      out.push(lines.join("\n\n"));
    } else {
      const lines = [`**${speaker}:** ${message.text.trim()}`.trimEnd()];
      const notes = replyNotes(message);
      if (notes) lines.push(notes);
      out.push(lines.join("\n\n"));
    }
  }
  return out;
}

// Private messages grouped by the round they followed, then by participant:
// the agents in speaking order, then the arbiters in arbiter order.
function privateConversations(table: Table): Map<number, Array<[string, PrivateMessage[]]>> {
  const groups = new Map<number, Array<[string, PrivateMessage[]]>>();
  const order = [...table.seats.map((s) => s.id as string), ...table.arbiters.map((a) => a.id)];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const ids = Object.keys(table.privateThreads).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const participantId of ids) {
    const byRound = new Map<number, PrivateMessage[]>();
    for (const message of table.privateThreads[participantId] ?? []) {
      const list = byRound.get(message.afterRound) ?? [];
      list.push(message);
      byRound.set(message.afterRound, list);
    }
    for (const [afterRound, messages] of byRound) {
      const group = groups.get(afterRound) ?? [];
      group.push([participantId, messages]);
      groups.set(afterRound, group);
    }
  }
  return groups;
}

// ---------- Names ----------

function seatHeading(table: Table, round: Round, seatId: string): string {
  const seat = round.seats?.find((s) => s.id === seatId) ?? table.seats.find((s) => s.id === seatId);
  return seat ? `### ${seatTitle(seat)}` : `### Agent ${seatId}`;
}

// "Agent A · Skeptic · Claude Sonnet 5.5", or "Agent A · Claude Sonnet 5.5"
// for an agent the host has not named.
function seatTitle(seat: Seat): string {
  return [`Agent ${seat.id}`, agentName(seat), seat.modelName].filter(Boolean).join(" · ");
}

function arbiterHeading(table: Table, round: Round, arbiterId: string): string {
  const arbiter = round.arbiters?.find((a) => a.id === arbiterId) ?? table.arbiters.find((a) => a.id === arbiterId);
  return arbiter ? `### ${arbiterTitle(arbiter)}` : "### Arbiter";
}

// "Tracker · Arbiter · Claude Haiku 5.5"
function arbiterTitle(arbiter: Arbiter): string {
  return `${arbiter.name} · Arbiter · ${arbiter.modelName}`;
}

// Who a private conversation is with, for its heading, and the name on the
// participant's messages. A participant no longer at the table is looked up
// in the rounds.
function privateNames(table: Table, participantId: string): { who: string; speaker: string } {
  if ((SEAT_LETTERS as readonly string[]).includes(participantId)) {
    const seat = table.seats.find((s) => s.id === participantId);
    return { who: `Agent ${participantId}`, speaker: seat ? seatTitle(seat) : `Agent ${participantId}` };
  }
  const arbiter =
    table.arbiters.find((a) => a.id === participantId) ??
    [...table.rounds].reverse().flatMap((r) => r.arbiters ?? []).find((a) => a.id === participantId);
  return arbiter ? { who: arbiter.name, speaker: arbiterTitle(arbiter) } : { who: "an arbiter", speaker: "Arbiter" };
}

function seatLine(seat: Seat): string {
  const name = agentName(seat);
  return `Agent ${seat.id}, ${name ? `${name}, ` : ""}${seat.modelName} (${MAKER_LABELS[seat.maker] ?? seat.maker})${seat.browsing ? ", browsing on" : ""}${seat.active === false ? ", off" : ""}`;
}

function arbiterLine(arbiter: Arbiter): string {
  return `${arbiter.name}, ${arbiter.modelName} (${MAKER_LABELS[arbiter.maker] ?? arbiter.maker})${arbiter.browsing ? ", browsing on" : ""}`;
}

// The one setting the host sees: Independent, or a Group table that answers
// in Parallel or in Round robin.
function modeLabel(setting: Pick<Table, "interaction" | "turns">): string {
  if (setting.interaction !== "group") return "Independent";
  return setting.turns === "roundRobin" ? "Round robin" : "Parallel";
}

// ---------- Small parts ----------

function toolsLine(tools: ToolActivity[]): string | null {
  if (tools.length === 0) return null;
  const items = tools.map((t) => {
    const what = t.tool === "web_search" ? `searched for "${t.label}"` : `read ${t.label}`;
    return t.status === "error" ? `${what} (failed)` : what;
  });
  return `*Tools: ${items.join("; ")}.*`;
}

function attachmentLine(attachments: Attachment[]): string | null {
  if (attachments.length === 0) return null;
  return `*Attachments: ${attachments.map((a) => a.name || "image").join(", ")}.*`;
}

function withPeriod(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function formatDate(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
