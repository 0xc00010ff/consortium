# Consortium specification

Consortium is a group chat of AI models. In the interface a table is called a conversation; the code and this document keep the word table. You write a message, every agent at the table answers it, and you decide what happens next.

Each exchange is a round. In a round, every agent answers, either all at the same time or one after another. Any arbiters, which are models with their own instructions, answer after the agents. Then the table waits for the host: a note, a private conversation with one agent or one arbiter, or the next round.

One setting, Interaction, changes how a table works, with three values. Independent: each agent reads only the host. Parallel: the agents read each other and answer at the same time. Round robin: the agents read each other and answer one after another in seat order, each reading the replies given before it in the same round. The data model keeps this as two fields, `interaction` (group or independent) and `turns` (parallel or roundRobin); Independent is independent plus parallel, and the interface never offers independent plus round robin.

This document is the build plan. The shared types live in `lib/types.ts`. Follow the writing guideline and product principle in `CLAUDE.md`.

## 1. How a table works

- **Round 1.** The host's first message goes to every agent. The agents answer at the same time, or one after another in round robin. Then each arbiter answers in turn, reading the whole round.
- **Interaction.** In a Group table, an agent reads the host's messages, the other agents' earlier replies, and the arbiters' replies. In an Independent table, an agent reads only the host's messages and its own earlier replies. Arbiters read everything in both cases.
- **Turns (the `turns` field).** With parallel, the default, every agent answers at the same time and none sees the others' replies from the current round. With roundRobin, the agents answer one at a time in seat order, each starting when the one before it has finished, and each reads the replies given before it in the same round. The arbiters answer after the last agent in both cases. A table without the field is parallel. The engine also accepts independent plus roundRobin (sequential, reading only the host) for older saved tables, but the interface does not offer it.
- **Seat order.** `Table.seats` is in speaking order, and the host can reorder it. Letters stay with their agents, so the order can be C, A, B. The engine never sorts agents by letter: replies, transcripts and the export follow the order of the round's seats.
- **Between rounds.** Nothing runs until the host presses Next round. The note can be empty.
- **Private conversations.** From any reply, the host can open a conversation with that one agent or arbiter and exchange as many messages as they like. Only that participant reads it, and it carries it into later rounds. No other agent or arbiter ever sees it.
- **Arbiters.** An arbiter is a participant with its own name and instructions. It answers after the agents in every round and after any earlier arbiter. The host can also talk with it privately, and it never reads anyone else's private conversation. A new table starts with one arbiter named Summarizer, on Claude Opus 5.5 when the list has it, with the instructions "Summarize the chat up to this point, and each Agent's most recent response, in one sentence each." The host can change or remove it.
- **Edits between rounds.** The host can change the title, the Interaction setting, the agents and their order, and the arbiters at any time the table is not busy. Changes apply from the next round. Past rounds keep the replies they have. An agent removed from the table keeps its old replies in the thread.
- **Stop.** While a round or a private reply is running, the host can stop it. Partial text is kept, and the round is marked stopped. The next round can still start.
- **Host instructions.** The host can give instructions to every agent, and separate instructions to one agent. Every agent reads the first kind, and the arbiters read them too as context. Only that agent reads the second kind.
- **Turning an agent off.** Between rounds, the host can turn an agent off. It stays at the table with its letter, its replies and its private conversation, and the others still read what it said. It does not answer rounds until the host turns it back on, and then it has read every round it sat out. The host can still talk with it privately.
- **Votes.** The host can vote any reply up or down, more than once, at any time, even during a round. Once a reply has votes, the models are told what votes mean and see the score under that reply. Until then, votes are never mentioned.
- **Rewind.** Between rounds, the host can go back to any round and send it again. That round and every round after it are deleted, along with the private messages sent after any of them, and the host's message from that round returns to the composer.

## 2. Stack

- Next.js 16 App Router, React 19, TypeScript. Read `node_modules/next/dist/docs/` before using framework APIs, because this version has breaking changes.
- AI SDK 7 through the AI Gateway. Use `instructions` (not `system`), `isStepCount`, `result.stream`, `onStepEnd`, and image parts of the form `{ type: "file", mediaType, data }`. Model ids are gateway strings such as `"anthropic/claude-sonnet-5.5"`.
- Plain CSS with the system font stack and small inline SVG icons; no web fonts or icon fonts. `react-markdown` with `remark-gfm` for message text. Vitest for tests.
- Dependencies are installed. Do not add packages without saying so.

## 3. Architecture

The browser owns the table. The server only calls models.

- **Store (client, `lib/engine/store.ts`).** `createTableStore(table, speak)` holds a `Table`, runs rounds and private messages by calling a `SpeakFn`, and publishes a new `Table` object after every change. It throttles streaming text to about every 50 ms.
- **Context builders (`lib/engine/context.ts`).** Pure functions that turn a `Table` into a `SpeakRequest` for an agent in a round, for an arbiter in a round, and for a private reply.
- **Speak client (`lib/client/speak.ts`)** and **speak route (`app/api/speak/route.ts`)**: The route calls `streamText` with the browsing tools when the participant has browsing on, streams `SpeakEvent` lines, limits a call to 5 minutes, and in mock mode writes scripted replies.
- **Models route (`app/api/models/route.ts`)**: unchanged, except the defaults field is now `{ seats, arbiter }`.
- **Storage (`lib/ui/storage.ts`)**: a client of `/api/conversations`, with a throttled save, a five-second poll for changes made elsewhere, and a merge on conflict. The server keeps each conversation as a file under `~/.consortium/conversations/`.

Mock mode is on when `AI_GATEWAY_API_KEY` is not set, or when `CONSORTIUM_MOCK=1`.

## 4. Running a round

`sendRound({ text, attachments })`:

1. Append a `Round` with `status: "running"`, the host message, one queued `Reply` per agent that is on, in seat order, and one queued `Reply` per arbiter. The round records the Interaction and Turns settings in effect (`turns` is always written, "parallel" when the table has none), and copies every agent, including those that are off, into `round.seats`. When every agent is off, `sendRound` rejects with "All agents are off. Turn one on, then try again."
2. In a parallel round, build every agent's request first, then run all agents at the same time. No agent sees another agent's reply from this round.
   In a round robin round, run the agents that are on one at a time in seat order. Each agent's request is built when its turn starts, so it includes the replies finished earlier in the round. The next agent starts when the previous one is done or failed.
3. When every agent is done or failed, run the arbiters one after another. Each arbiter's request includes this round's agent replies and the replies of arbiters that came before it in this round.
4. Mark the round done. A failed reply gets `status: "error"` and a plain message, and the round continues without it.

`sendPrivate(participantId, { text, attachments })` talks with an agent, by its letter, or an arbiter, by its id such as "arbiter-1". `privateThreads` is keyed by the same id.

1. Reject with "Agent D is not at this table." or "The arbiter arbiter-2 is not at this table." when the participant is not at the table.
2. Append a host `PrivateMessage` with `afterRound` set to the number of the last round, and a queued message for the participant. Its `role` is "seat" for an arbiter too.
3. Build the participant's request from the table and the private thread, and stream the reply into that message. Stop and errors work as for a round.

`stop()` aborts all in-flight requests. Replies that were streaming keep their text, get `status: "error"` with the error "Stopped", and any running tool entry becomes an error with the detail "Stopped". A running round becomes `status: "stopped"`. In a round robin round, the agents still waiting for their turn are marked stopped the same way and never start.

`edit(edit)` applies the edit to the table when it is not busy. Adding an agent gives it the next free letter. Removing an agent or an arbiter deletes its private thread. Renaming, reordering or switching off agents keeps every thread, including the arbiters'.

`vote(replyId, delta)` adds `delta` to the reply's `votes`, also while the table is busy. A model that starts after the vote reads it.

`rewind(roundNumber)` deletes that round, every round after it, and every private message with `afterRound >= roundNumber`, with agents and with arbiters, then returns the deleted round's host message. Private messages sent before that round began stay. The table's title stays, and the next round gets the number `roundNumber` again. It returns null and changes nothing while the table is busy or when there is no such round.

## 5. What the models read

Every request has one `instructions` string and one user message. The user message holds the transcript as markdown and ends with a short "Now" section. Keeping the transcript before "Now" keeps the start of the message stable as the table grows, which helps prompt caching.

### Agent instructions

"You are Agent B at a table with agents A, C and D. Each agent is an AI model. The host is the person who runs the table and speaks to it between rounds. In each round, every agent answers at the same time, so you do not see the other agents' replies from the current round."

In a round robin round, the last sentence is replaced by the order, listing only the agents that are on: "In each round, the agents answer one after another, in the order C, A, B." In a Group table, a sentence about the agent's place follows:

- First: "You answer first, and the agents after you will read your reply."
- In the middle: "You answer after Agent C. You can read the replies given before yours in the current round, and the agent after you will read your reply."
- Last: "You answer last, after Agent A. You can read the replies given before yours in the current round."

"The agent after you" becomes "the agents after you" when more than one follows. In an Independent table only the order sentence is added. With fewer than two agents on, neither is said. A private reply's instructions follow the Turns setting of the last round, as they follow its Interaction setting.

For a Group table, add: "You can read the other agents' replies and the arbiters' replies from earlier rounds. Respond to specific points when it helps, and say when you disagree. Do not repeat what others have already said."

For an Independent table, add: "You cannot read the other agents. Answer the host directly."

Once any reply on the table has votes, add: "The host votes replies up or down to reward the ones they found most useful, and can vote on a reply more than once. A reply with votes shows its score under it in the transcript, such as "Host votes: +2"."

Then: "Reply in plain text or markdown. Keep replies to about 200 words unless the host asks for more." With browsing on, add one sentence about the web_search and read_page tools.

After that, as separate paragraphs, the host's instructions: "The host gave these instructions to every agent:" followed by the table's instructions, and "The host gave these instructions to you. The other agents do not see them." followed by this agent's own. Blank instructions add nothing.

The first sentence names every agent at the table, including any that are off.

### Agent names

The models know each agent by its letter, and the host can add a name. A named agent's name follows its letter in parentheses wherever a prompt mentions it: in sentences ("Agent A (Skeptic)"), in lists ("agents A (Skeptic), B (Optimist) and C"), and in transcript headings ("### Agent A (Skeptic)", or "### Agent A (Skeptic, you)" for the reader's own replies). An agent without a name keeps the plain form, such as "Agent C" and "### Agent C (you)". A named agent is also told its name once, right after the opening sentence:

"You are Agent B (Optimist) at a table with agents A (Skeptic) and C. The host calls you Optimist."

Names are trimmed, line breaks become spaces, and a blank name counts as no name. The transcript takes each name from the round's own record of the agents, so naming an agent later does not change earlier rounds. The instructions take names from the table as it is now. The interface's colors never reach the models. The export puts the name between the letter and the model: "### Agent A · Skeptic · Claude Sonnet 5.5" as a heading, and "Agent A, Skeptic, Claude Sonnet 5.5 (Anthropic)" in the list of agents.

### Arbiter instructions

"You are an arbiter named Tracker at a table of AI models. The host runs the table. In each round, the agents answer first, and then you answer. (In a round robin round: "In each round, the agents answer one after another, in the order C, A, B, and then you answer.") You can read everything the host, the agents and the other arbiters have said. Follow these instructions from the host:" followed by the arbiter's instructions, then the host's instructions to every agent, then the reply format sentence. The votes sentence follows the same rule as for agents. An arbiter never reads one agent's own instructions.

### Transcript for an agent

Rendered as markdown, round by round:

```
## Round 1
### Host
...
### Agent A
...
### Agent B (you)
...
### Tracker (arbiter)
...
### Private conversation between the host and you, after round 1
**Host:** ...
**You:** ...
## Round 2
### Host
...
```

In an Independent table, leave out the other agents and the arbiters. In both cases, leave out replies that are not done. In a parallel round, leave out the current round entirely; its host message goes in the "Now" section. In a round robin round, render the current round like the earlier ones: the host's message with its images, then, in a Group table, the replies finished before this agent's turn. A reply with votes has a line such as `*Host votes: +2*` under it. A round in which some agents were off has a line such as `*Agents B and D sat out this round.*` under the host's message, so the models do not think those agents failed. In a round robin round, the line under the current round's host message is in the present tense: `*Agent B sits out this round.*` Agents are always called by letter, with the host's name for the agent when it has one (see Agent names). The host sees model names, the models do not. The private conversation block appears only in that agent's transcript, placed after the round it followed.

The "Now" section for a round says: "Round 3. The host wrote: ..." or, with an empty note, "Round 3. The host added no note. Continue from where the table left off." When some agents are off, "Agents B and D sit out this round." (or "Agent B sits out this round.") follows "Round 3." The arbiter's "Now" section says the same in the past tense: "Agents B and D sat out this round." In a round robin round, the host's message and its images are already in the transcript, so the "Now" section says whose turn it is and what to answer, without repeating the message:

- First agent: "Round 3. You answer first this round. Reply to the host's message."
- A later agent in a Group table: "Round 3. It is your turn. Agent A has already replied this round. Reply to the host's message, and respond to Agent A where it helps." Only replies that finished are named. With none, or in an Independent table: "Round 3. It is your turn. Reply to the host's message."
- With no note: "The host added no note. Continue from where the table left off" takes the place of "Reply to the host's message", with ", and respond to Agent A where it helps." when it applies. Images with no text and an empty first message follow the same wording as the parallel case, and the images are numbered in the transcript.

For an agent's private reply it says: "The host is now talking with you privately. The other agents and the arbiters do not see this. Reply to the host's last message."

### Transcript for an arbiter

The same rendering with every agent and every arbiter included, in both Interaction settings. For the current round, include the agent replies and the earlier arbiters' replies. The arbiter's own private conversation with the host is included, placed after the round it followed under the heading "### Private conversation between the host and you, after round 1". Other private conversations, with agents or with other arbiters, are never included.

An arbiter's private reply reads the whole transcript, with its own instructions as in a round, and its "Now" section says: "The host is now talking with you privately. The agents and the other arbiters do not see this. Reply to the host's last message." With no other arbiter at the table, the second sentence is "The agents do not see this."

### Length limits

`maxOutputTokens` of 8000 for agents and arbiters and 4000 for private replies. The limits are generous because reasoning models count their thinking against them.

## 6. Mock mode

Mock replies must make every flow work with no key, and read like plausible short replies.

- Agent replies: two or three short paragraphs that mention the host's message. In a Group round after round 1, refer to another agent by letter. Vary by agent.
- Arbiter replies: a short numbered list that reads like tracking or a summary, mentioning agents by letter.
- Private replies: a direct answer to the host's last message. An arbiter's private reply also says where each agent stood in the last round.
- With browsing on, sometimes emit a tool-start and tool-end pair before the text.
- Wait 400 to 1200 ms before the first text, then stream about 20 ms per word. `CONSORTIUM_MOCK_DELAY=0` removes delays for tests.

## 7. Interface

The target is a minimal, high-quality desktop tool in the vein of ChatGPT, Cursor, Claude Code, Codex and GitHub: neutral colors, 1 px borders instead of elevation, small radii (6 to 8 px, with pills only for small chips), compact controls, a system font stack, and no drawn table or seating imagery. Light theme by default, dark following the system setting.

- **Type:** the system UI stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`) at 14 px for the interface and 15 px for message text, with `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` for tokens and timings. No web fonts and no icon font. Icons are small inline SVGs with 1.5 px strokes, in the style of Lucide.
- **Color, light:** page `#ffffff`, sidebar and panels `#f7f7f8`, borders `#e3e3e3`, text `#111111`, secondary text `#6b6b6b`, hover `#ececec`, selected row `#e8e8e8`, the primary button near-black with white text, links and focus rings a restrained blue `#2f6fed`. Agent colors stay muted and readable on both themes.
- **Color, dark:** page `#1a1a1a`, sidebar and panels `#141414`, borders `#2e2e2e`, text `#ececec`, secondary `#9a9a9a`, hover `#262626`, selected `#2c2c2c`, the primary button light with dark text.
- **Shape:** the sidebar is full height, with a New table button at the top and the recent tables as compact rows with a subtle selected background. The thread column has a slim header (44 to 48 px) holding the title and the Export and Participants actions. The composer is a bordered box with the text area inside and the attach and send controls at its bottom edge. The participants panel uses plain rows with 1 px dividers.

### Layout

- **App bar** (64 px): menu icon, the Consortium mark and name, the table title with a second line such as "Group · 4 agents · 1 arbiter · Round 2", an Export button, and a Participants icon button that opens or closes the right panel.
- **Left navigation** (256 px): a New table button and the list of recent tables with a short relative time. The current table is highlighted.
- **Thread**: rounds in order, each with a round heading. Under it, the host message, then each agent's reply, then each arbiter's reply. A reply shows an avatar with the agent letter, the model name, "Agent A", the time taken, tool activity as small chips, and the text as markdown. A finished round's heading can collapse the round. Under an agent or arbiter reply, a "Reply privately" action opens the private conversation. If a private conversation exists, a chip under that reply says "Private conversation · 4 messages" and opens it.
- **Composer** (bottom of the thread): a text field, an attach button, and the primary button. For a new table the field says "Write the first message" and the button says Send. After that the field says "Add a note for round 3 (optional)" and the button says Next round. Ctrl or ⌘ with Enter also sends. While a round runs, the button becomes Stop. A helper line says who will reply.
- **Participants panel** (380 px, right): the Interaction setting as a three-option segmented control, Independent, Parallel and Round robin; the system prompt; the agents in speaking order, which the host can reorder, each with an avatar, a model select, a browsing switch and a remove button; Add agent; the arbiters, each with a name field, a model select, a browsing switch, an instructions field and a remove button; Add arbiter. New arbiters are named "Arbiter 1", "Arbiter 2" and get the default arbiter model. The panel is disabled while the table is busy.
- **Private conversation** (replaces the panel): the agent's avatar and model name, "Agent B · Private conversation", a close button, a note saying only this agent sees the conversation, the agent's latest round reply quoted at the top, the messages, a message field with a send button, and a Back to the table button.
- **Narrow windows**: the conversation keeps at least 480 px. When the window is too narrow for that beside both side panels, the left navigation becomes a pop-over that opens over the thread from the left; when it is too narrow beside the right panel alone, the right panel becomes a pop-over from the right too. With the default widths these steps come at 1116 px and 860 px. A dimmed layer sits behind an open pop-over, and only one is open at a time. The header then always starts with the sidebar button. A press on the dimmed layer, Escape, the panel's close button, or choosing a table closes the open pop-over, and closing a private conversation returns to the thread. Under 640 px the Export button shows only its icon and the thread's side spacing tightens; on a phone a reply's toolbar shows the time taken without the token counts.
- **Resizing**: while a side panel sits beside the conversation, its inner edge can be dragged: the left navigation between 200 and 420 px, the right panel between 320 and 600 px, and never so far that the conversation drops under 480 px. The edge is also a keyboard separator (arrow keys move it by 16 px, Home and End go to the limits) and a double-click restores the default width. The widths are kept in the browser.

### Behavior

- **First run.** When no API key is set anywhere, the setup is not marked done, and sample mode is not forced, the model list answers with `needsSetup` and the app opens a three-step dialog: Coding agents (Claude Code and Codex as found on the machine, with install commands and a path field for one that is not found, and Check again), API key (a link to get a Vercel AI Gateway key and the key field), and Ready (what is in place). Closing it by any route saves `setupDone` in the settings file, so it shows once per machine. Everything in it is also in Settings.
- A new table opens with one agent per default model (Claude Code and Codex when they are installed, otherwise one model per maker from the gateway), the Summarizer arbiter, Group interaction, and the first-message composer. Its title is "Untitled conversation" until the first message is sent, when it becomes the first few words of that message. The title can be edited by clicking it.
- Replies stream as they arrive. The thread stays scrolled to the newest content unless the user has scrolled up, in which case a "Scroll to newest" button appears.
- Tables save to localStorage as they change. Reopening a table that was running shows its last state with the round marked stopped.
- Export downloads the table as markdown: the title, the Interaction setting ("- Interaction: Independent", "Parallel" or "Round robin"), with a note such as "*Interaction changed to Round robin for this round.*" on a round where it changed, the list of participants with ", off" after an agent that is off, the host's instructions, each round with the host message and every reply, and each private conversation under the round it followed, the agents' first in speaking order, then the arbiters' in arbiter order. A conversation with an arbiter is headed "### Private conversation with Tracker, after round 1", and its replies start with "**Tracker · Arbiter · Claude Haiku 5.5:**". Votes and agents that sat out a round appear as they do in the transcript.
- Images can be attached by picking a file, pasting, or dropping onto the composer, and are resized to at most 1600 px.
- Keyboard focus is visible on every control. Buttons say what they do. Error messages say what went wrong and what to do.

### Copy

All interface text follows the writing guideline in `CLAUDE.md`. Labels are plain nouns: Interaction, Agents, Arbiters, Participants, Export, New table, Next round, Reply privately, Back to the table.

## 8. Tests and acceptance

Unit tests with Vitest and a fake `SpeakFn`:

- A round runs every agent at once and then the arbiters one by one, in order. In round robin, the agents run one at a time in seat order, each request is built at its turn and reads the earlier replies, a failed agent does not block the next, and Stop marks the waiting agents stopped.
- An agent's request in a Group table includes other agents' earlier replies and excludes replies from the current round. In an Independent table it excludes other agents and arbiters entirely.
- An arbiter's request includes this round's agent replies and earlier arbiters' replies, and only its own private thread.
- A private thread appears only in that agent's or arbiter's request, after the right round.
- Stop keeps partial text, marks the round stopped, and the next round can start.
- A failed agent does not stop the round.
- Edits are refused while busy and apply from the next round.
- Export produces the expected markdown.
- The speak and models routes work in mock mode.

Acceptance for the whole app: `npm run build`, `npm run lint` and `npm test` pass. In mock mode, with no console errors: a new table runs two rounds with a note, an arbiter added between rounds answers in the next round, a private conversation with two exchanges works and shows in the thread, switching to Independent applies to the next round, Stop works mid-round, Export downloads, and a reload keeps the table.

## 9. Engine exports used by the interface

```ts
// lib/engine/store.ts
export function createTableStore(table: Table, speak: SpeakFn): TableStore;

// lib/engine/table.ts
export function newTable(defaults: ModelsResponse, models: ModelInfo[]): Table; // one agent per default model, the Summarizer arbiter, group
export function titleFrom(text: string): string; // the first few words of the first message

// lib/client/speak.ts
export const speak: SpeakFn;

// lib/engine/export.ts
export function tableToMarkdown(table: Table): string;
```

## 10. File ownership

Two builders work at the same time.

- **Engine builder:** `lib/engine/**`, `lib/client/**`, `lib/server/**`, `app/api/**`, their tests, `vitest.config.mts`, `.env.example`. 
- **Interface builder:** `app/**` outside `app/api`, `components/**`, `lib/ui/**`, `public/**`. 
- **Shared:** `lib/types.ts`. Add fields only, and list every change in your report.
