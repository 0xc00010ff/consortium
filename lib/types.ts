// Shared contract for Consortium v2.
// The engine (lib/engine, lib/server, app/api) and the interface (app,
// components, lib/ui) both depend on this file. Change it only by adding
// fields, and list any change in your report.

// ---------- Participants and models ----------

export const SEAT_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type SeatId = (typeof SEAT_LETTERS)[number];

// The agent colors, in the order the letters use them by default: A is
// blue, B is green, and so on. The host can give an agent any of them.
export const SEAT_COLORS = ["blue", "green", "purple", "orange", "teal", "pink", "olive", "brown"] as const;
export type SeatColor = (typeof SEAT_COLORS)[number];

export type Maker = "anthropic" | "openai" | "google" | "xai";
export const MAKER_LABELS: Record<Maker, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
};

export interface ModelInfo {
  // An AI Gateway id such as "anthropic/claude-sonnet-5.5", or the id of a
  // command line tool on this machine that runs on the host's own
  // subscription: "cli/claude-code" (Claude Code) or "cli/codex" (Codex).
  id: string;
  name: string; // "Claude Sonnet 5.5", or "Claude Code" / "Codex" for a tool
  maker: Maker;
  // For a command line tool: the model it uses by default, in the tool's own
  // words, such as "Sonnet 4.5" or "gpt-6-astra". Shown as the "Default"
  // choice of the tool's model dropdown. Absent for gateway models.
  defaultModel?: string;
  // For a command line tool: the models the host can run it with instead of
  // its default. Absent for gateway models.
  toolModels?: ToolModel[];
}

// A model choice for a command line tool. `id` is what the tool accepts,
// such as "opus" for Claude Code or "gpt-6-astra" for Codex.
export interface ToolModel {
  id: string;
  name: string;
}

export interface Seat {
  id: SeatId;
  modelId: string;
  modelName: string;
  maker: Maker;
  // The host's name for the agent, shown in place of the model name and
  // given to the models next to the letter. Absent means the model name.
  name?: string;
  color?: SeatColor; // absent means the letter's own color
  browsing: boolean; // default true
  // For a command line tool: the ToolModel id to run it with. Absent means
  // the tool's own default.
  toolModel?: string;
  instructions?: string; // the host's prompt for this agent alone
  // false means the agent sits out the rounds until the host turns it back
  // on. It stays at the table, keeps its replies and its private conversation,
  // and the others still read what it said. Absent means on.
  active?: boolean;
}

// An arbiter answers after the seats, every round, following its instructions.
export interface Arbiter {
  id: string; // "arbiter-1", "arbiter-2"...
  name: string; // shown in the thread, for example "Tracker"
  modelId: string;
  modelName: string;
  maker: Maker;
  browsing: boolean; // default false
  toolModel?: string; // as for a Seat
  instructions: string;
}

// ---------- Messages ----------

export interface Attachment {
  id: string;
  name: string;
  mediaType: string; // e.g. "image/png"
  dataUrl: string; // base64 data URL, images resized client-side
}

export type ToolName = "web_search" | "read_page";

export interface ToolActivity {
  id: string;
  tool: ToolName;
  label: string; // the search query or the URL
  status: "running" | "done" | "error";
  detail?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export type ReplyStatus = "queued" | "streaming" | "done" | "error";

export interface Reply {
  id: string;
  participantId: string; // a SeatId or an Arbiter id
  text: string; // markdown
  status: ReplyStatus;
  tools: ToolActivity[];
  usage?: Usage;
  durationMs?: number;
  error?: string;
  startedAt?: number;
  finishReason?: string;
  // The host's votes on this reply: each press of up adds one and each press
  // of down takes one away. Absent or 0 means no vote.
  votes?: number;
}

export interface HostMessage {
  text: string; // may be empty for a round after the first
  attachments: Attachment[];
  createdAt: number;
}

// ---------- The table ----------

// group: seats read the host, the other seats and the arbiters.
// independent: each seat reads only the host and its own earlier replies.
// Arbiters read everything in both cases.
export type Interaction = "group" | "independent";

// parallel: every agent answers at the same time and none sees the others'
// replies from the current round.
// roundRobin: the agents answer one after another in the order of
// Table.seats, and in a Group table each one reads the replies given earlier
// in the same round. The arbiters still answer after the last agent.
export type Turns = "parallel" | "roundRobin";

export type RoundStatus = "running" | "done" | "stopped";

export interface Round {
  number: number; // 1, 2, 3...
  interaction: Interaction; // the setting in effect for this round
  turns?: Turns; // the setting in effect for this round; absent means parallel
  host: HostMessage; // the first message, or the optional note for later rounds
  replies: Reply[]; // one per agent that was on, in speaking order; at once, or one by one in round robin
  arbiterReplies: Reply[]; // one per arbiter, in arbiter order; they run one after another
  status: RoundStatus;
  // The seats and arbiters in effect for this round, copied when the round
  // starts. The thread uses them to name a reply after its seat was removed or
  // its model changed. Optional so older saved tables still load.
  seats?: Seat[];
  arbiters?: Arbiter[];
}

// A private conversation between the host and one seat. Only that seat
// reads it. afterRound says where it sits in that seat's transcript.
export interface PrivateMessage {
  id: string;
  role: "host" | "seat";
  text: string;
  attachments?: Attachment[];
  status: ReplyStatus; // host messages are always "done"
  tools: ToolActivity[];
  usage?: Usage;
  durationMs?: number;
  error?: string;
  startedAt?: number; // when the seat began its reply, as for a Reply
  finishReason?: string;
  afterRound: number;
  createdAt: number;
}

export interface Table {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  interaction: Interaction;
  turns?: Turns; // absent means parallel
  // 1 to 8, in speaking order. The host can reorder them; the letters stay
  // with their agents.
  seats: Seat[];
  arbiters: Arbiter[]; // 0 or more
  rounds: Round[];
  privateThreads: Partial<Record<SeatId, PrivateMessage[]>>;
  instructions?: string; // the host's prompt for every agent
}

// Edits the host can make between rounds. They apply from the next round.
export type TableEdit = Partial<Pick<Table, "title" | "interaction" | "turns" | "seats" | "arbiters" | "instructions">>;

// Owns one table in the browser. It publishes a new Table object after every
// change, so React can read it with useSyncExternalStore.
export interface TableStore {
  getTable(): Table;
  subscribe(listener: () => void): () => void;
  isBusy(): boolean; // a round or a private message is in progress
  // Starts the next round with this host message. Resolves when the round
  // is done or stopped. Rejects only on a programming error.
  sendRound(message: { text: string; attachments: Attachment[] }): Promise<void>;
  // Sends a private message to one seat and streams its reply.
  sendPrivate(seatId: SeatId, message: { text: string; attachments: Attachment[] }): Promise<void>;
  stop(): void; // aborts whatever is in progress; partial text is kept
  edit(edit: TableEdit): void; // refused while busy
  // Adds delta (1 or -1) to a reply's votes. Allowed at any time; a model
  // that starts after the vote reads it.
  vote(replyId: string, delta: number): void;
  // Deletes round `roundNumber` and every round after it, along with the
  // private messages with afterRound >= roundNumber, so the host can send
  // that round again. A private conversation held before that round stays.
  // Returns the deleted round's host message for the composer, or null if
  // there is no such round or the table is busy.
  rewind(roundNumber: number): HostMessage | null;
}

// createTableStore(table: Table, speak: SpeakFn): TableStore is exported from lib/engine/store.ts.

// ---------- /api/speak protocol ----------

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  attachments?: Attachment[];
  afterAttachments?: string; // text placed after the images
}

export interface MockHint {
  purpose: "seat" | "arbiter" | "private";
  interaction: Interaction;
  round: number;
  seatId?: SeatId;
  arbiterName?: string;
}

export interface SpeakRequest {
  modelId: string;
  // For a command line tool: the ToolModel id to run it with. The server
  // ignores it for gateway models.
  toolModel?: string;
  instructions: string;
  messages: ChatTurn[];
  browsing: boolean;
  maxOutputTokens?: number;
  mockHint?: MockHint;
}

// The response body is newline-delimited JSON, one SpeakEvent per line.
export type SpeakEvent =
  | { type: "text"; delta: string }
  | { type: "tool-start"; id: string; tool: ToolName; label: string }
  | { type: "tool-end"; id: string; ok: boolean; detail?: string }
  | { type: "done"; usage: Usage; durationMs: number; finishReason?: string }
  | { type: "error"; message: string };

export interface SpeakResult {
  text: string;
  tools: ToolActivity[];
  usage: Usage;
  durationMs: number;
  finishReason?: string;
}

export interface SpeakHandlers {
  onText?(delta: string, fullText: string): void;
  onTools?(tools: ToolActivity[]): void;
}

// speak() is exported from lib/client/speak.ts. It rejects with an Error on
// network or model errors, and with an AbortError when the signal aborts.
export type SpeakFn = (
  request: SpeakRequest,
  handlers: SpeakHandlers,
  signal: AbortSignal,
) => Promise<SpeakResult>;

// ---------- /api/models ----------

export interface ModelsResponse {
  // true when the server writes the replies itself: CONSORTIUM_MOCK=1, or no
  // AI_GATEWAY_API_KEY and no command line tool installed.
  mock: boolean;
  models: ModelInfo[]; // the short list, in maker order and tier order
  defaults: {
    seats: string[]; // one model id per maker, for a new table
    arbiter: string; // a small, fast model id for a new arbiter
  };
}
