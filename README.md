# Consortium

Consortium is a group chat of AI models. You write a message, every agent at the table answers it, and you decide what happens next.

Each exchange is a round. In a round, every agent answers, all at the same time or one after another. Any arbiters, which are models with their own instructions, answer after the agents. A new table starts with one arbiter named Summarizer, which sums up the chat and each agent's latest reply in a sentence each; you can change it or remove it. Then the table waits for you: add a note, have a private conversation with one agent, or press Next round.

One setting, Interaction, changes how a table works. Independent: each agent reads only you. Parallel: the agents read each other and answer at the same time. Round robin: the agents read each other and answer one after another in list order, each reading the replies given before it. Arbiters read everything in every case.

## Running it

Install the packages and start the development server:

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:3000.

To use real models, copy `.env.example` to `.env.local` and set `AI_GATEWAY_API_KEY` to a Vercel AI Gateway key. Restart the server after you change it. Nothing runs until you send a message or press Next round. Each round sends the whole transcript so far to every agent, so later rounds cost more than early ones.

To try the app without spending anything, run it in sample mode. The app then writes the replies itself:

```bash
npm run dev:mock
```

## Using your Claude Code and Codex subscriptions

If Claude Code or Codex is installed on this machine, you can choose it as the model for any agent or arbiter. Calls then run through that tool and bill your Claude or ChatGPT subscription, with no gateway key needed.

The model picker lists each installed tool first, by name. A new table starts with the installed tools as its agents, so with both installed you get Claude Code and Codex, and a new arbiter starts on Claude Code when it is installed. Without a gateway key, these tools are the only models in the list.

When you pick a tool, a second dropdown picks the model the tool runs with. Claude Code offers Fable, Opus, Sonnet and Haiku, and Codex offers the current OpenAI models plus the one set in `~/.codex/config.toml`. "Default" keeps the tool's own choice, so it answers with the same model it uses when you run it yourself. For Claude Code, the default reads "default model" until its first reply on the default, which names the model in use.

Nothing runs until you send a message or press Next round. Each call starts the tool once in a new, empty temporary folder, so it cannot read or change your project, and that folder is deleted afterwards. With browsing on, Claude Code may use only web search and page fetching, and Codex may use only web search. With browsing off, neither has any tools.

Consortium looks for `claude` and `codex` on your PATH and in the usual install folders, and for Codex also inside the Codex desktop app. If a tool lives somewhere else, set `CONSORTIUM_CLAUDE_BIN` or `CONSORTIUM_CODEX_BIN` in `.env.local` to its full path. The tool must already be signed in, which you can check by running it once in a terminal.

## Checks

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run build
```

## Where things are

- `docs/v2-spec.md` is the specification for this version.
- `docs/design/round-by-round.html` holds the design, which the app follows for layout and copy.
- `lib/types.ts` is the shared data model.
- `lib/engine/` holds the table store, the prompts the models read, and the markdown export.
- `lib/server/` and `app/api/` call the models through the AI Gateway, or through Claude Code and Codex in `lib/server/cli.ts`, with the sample replies in `lib/server/mock.ts`.
- `components/` and `lib/ui/` hold the interface.

Tables are saved in your browser's local storage.

## Local use only

This version is meant to run on your own machine. The model route has no sign-in, so anyone who can reach a deployed copy could spend your gateway credit or your Claude and ChatGPT subscription usage. The page-reading tool can also reach addresses on your local network, which is useful for reviewing local and staging sites. Do not deploy it publicly without adding authentication first.
