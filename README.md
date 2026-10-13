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

To use real models, add an API key in Settings, as described below. Nothing runs until you send a message or press Next round. Each round sends the whole transcript so far to every agent, so later rounds cost more than early ones.

To try the app without spending anything, run it in sample mode. The app then writes the replies itself:

```bash
npm run dev:mock
```

## Settings

Settings holds your API keys and the paths to Claude Code and Codex. It saves them in `~/.consortium/settings.json`, which only your user account can read, and a change takes effect on the next message without a restart. To keep the file somewhere else, set `CONSORTIUM_HOME` to a folder.

The simplest setup is one Vercel AI Gateway key. It runs every model in the list and also gives agents web search. Without a gateway key, you can add a key from Anthropic, OpenAI, Google or xAI instead. The list then shows only those makers' models, and each call goes straight to that maker's API. With a gateway key set, the gateway is used for every model and the other keys are not used.

Web search needs the gateway key. With provider keys only, an agent with browsing on can still read a page whose URL it knows, and it is told that web search is not available.

Environment variables still work, for example in `.env.local`: `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` (or `GEMINI_API_KEY`) and `XAI_API_KEY`. A key saved in Settings wins over the same key in the environment. Restart the server after you change `.env.local`.

Your conversations and presets are saved next to the settings file, so they stay the same across browsers, ports and restarts. Each conversation is one file in `~/.consortium/conversations/`, named by the conversation's id, and the presets are one list in `~/.consortium/presets.json`. To back up your history, copy `~/.consortium`. To delete a conversation outside the app, delete its file. The browser keeps only a cache of what the server has saved.

```
~/.consortium/
  settings.json
  presets.json
  conversations/
    <conversation id>.json
```

## Using your Claude Code and Codex subscriptions

If Claude Code or Codex is installed on this machine, you can choose it as the model for any agent or arbiter. Calls then run through that tool and bill your Claude or ChatGPT subscription, with no gateway key needed.

The model picker lists each installed tool first, by name. A new table starts with the installed tools as its agents, so with both installed you get Claude Code and Codex, and a new arbiter starts on Claude Code when it is installed. Without any API key, these tools are the only models in the list.

When you pick a tool, a second dropdown picks the model the tool runs with. Claude Code offers Fable, Opus, Sonnet and Haiku, and Codex offers the current OpenAI models plus the one set in `~/.codex/config.toml`. "Default" keeps the tool's own choice, so it answers with the same model it uses when you run it yourself. For Claude Code, the default reads "default model" until its first reply on the default, which names the model in use.

Nothing runs until you send a message or press Next round. Each call starts the tool once in a new, empty temporary folder, so it cannot read or change your project, and that folder is deleted afterwards. With browsing on, Claude Code may use only web search and page fetching, and Codex may use only web search. With browsing off, neither has any tools.

Consortium looks for `claude` and `codex` on your PATH and in the usual install folders, and for Codex also inside the Codex desktop app. If a tool lives somewhere else, enter its full path in Settings, or set `CONSORTIUM_CLAUDE_BIN` or `CONSORTIUM_CODEX_BIN` in `.env.local`. A path in Settings wins over the environment variable. The tool must already be signed in, which you can check by running it once in a terminal.

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

- `docs/spec.md` is the specification.
- `lib/types.ts` is the shared data model.
- `lib/engine/` holds the table store, the prompts the models read, and the markdown export.
- `lib/server/` and `app/api/` call the models through the AI Gateway or a provider's API (`lib/server/providers.ts`), or through Claude Code and Codex in `lib/server/cli.ts`, with the sample replies in `lib/server/mock.ts`. `lib/server/settings.ts` reads and writes the settings file, and `lib/server/conversations.ts` and `lib/server/presets.ts` save conversations and presets under the same folder, served by `app/api/conversations` and `app/api/presets`.
- `components/` and `lib/ui/` hold the interface.

Conversations and presets are files under `~/.consortium`, as described in Settings.

## Local use only

This version is meant to run on your own machine. The routes have no sign-in, so anyone who can reach a deployed copy could read your saved API keys and conversations, spend your gateway or provider credit, or use your Claude and ChatGPT subscriptions. The page-reading tool can also reach addresses on your local network, which is useful for reviewing local and staging sites. Do not deploy it publicly without adding authentication first.
