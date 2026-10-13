"use client";

// Saved Participants setups. A preset holds the interaction, turns, system
// prompt, agents and arbiters of a table, without their ids. The server keeps
// the whole list on disk (see app/api/presets). Each change here is applied to
// a fresh copy of the server's list and written back whole, so presets saved
// in another tab are kept, and the list reloads along with the tables.

import { useSyncExternalStore } from "react";
import {
  SEAT_LETTERS,
  type Arbiter,
  type ModelInfo,
  type ModelsResponse,
  type Preset,
  type PresetsResponse,
  type Seat,
  type Table,
  type TableEdit,
} from "@/lib/types";
import { SUMMARIZER_INSTRUCTIONS, SUMMARIZER_NAME } from "./engine";
import { uid } from "./format";
import { createStore, describeFailure, errorFrom, onRefresh, request, setWarning, startSync } from "./storage";

export type { Preset };

const API = "/api/presets";
const EMPTY: Preset[] = [];

type Change = (list: Preset[]) => Preset[];

let server: Preset[] = EMPTY; // the list as last read from or written to the server
let queue: Change[] = []; // changes made here and not yet saved
let syncing = false;
let syncAgain = false;

const presetsStore = createStore<Preset[]>(() => {
  start();
  return EMPTY;
}, EMPTY);

let started = false;
function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  startSync();
  setTimeout(() => void sync(), 0);
}

onRefresh(() => {
  if (started) void sync();
});

// The server's list with this page's unsaved changes on top.
function show() {
  const next = queue.reduce((list, change) => change(list), server);
  if (JSON.stringify(next) !== JSON.stringify(presetsStore.get())) presetsStore.set(next);
}

// Reads the server's list and, when there is anything to save, writes it back
// with the changes applied. A failed save keeps the changes for the next try.
async function sync() {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    const res = await request(API);
    if (!res.ok) throw await errorFrom(res);
    let list = ((await res.json()) as PresetsResponse).presets;
    const changes = queue.length;
    if (changes) {
      const next = queue.slice(0, changes).reduce((l, change) => change(l), list);
      const put = await request(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presets: next } satisfies PresetsResponse),
      });
      if (!put.ok) throw await errorFrom(put);
      list = ((await put.json()) as PresetsResponse).presets;
      queue = queue.slice(changes);
    }
    server = list;
    setWarning("presets", null);
  } catch (err) {
    // A failed read with nothing to save needs no warning of its own; the
    // list of conversations already says the server cannot be reached.
    if (queue.length) setWarning("presets", describeFailure("Could not save the presets.", err));
  } finally {
    syncing = false;
    show();
    if (syncAgain) {
      syncAgain = false;
      void sync();
    }
  }
}

// The change shows here at once and is saved in the background.
function update(change: Change) {
  queue.push(change);
  show();
  void sync();
}

export function listPresets(): Preset[] {
  return presetsStore.get();
}

export function usePresets(): Preset[] {
  return useSyncExternalStore(presetsStore.subscribe, presetsStore.get, presetsStore.server);
}

// Saves the table's Participants setup. A name already in use replaces that preset in place.
export function savePreset(name: string, table: Table) {
  const clean = name.trim();
  if (!clean) return;
  const setup = {
    interaction: table.interaction,
    turns: table.turns,
    instructions: table.instructions,
    seats: table.seats.map(withoutId),
    arbiters: table.arbiters.map(withoutId),
  };
  const id = uid();
  const createdAt = Date.now();
  update((list) => {
    const at = list.findIndex((p) => p.name === clean);
    if (at === -1) return [...list, { id, name: clean, createdAt, ...setup }];
    return list.map((p, i) => (i === at ? { ...p, ...setup } : p));
  });
}

function withoutId<T extends { id: string }>(item: T): Omit<T, "id"> {
  const copy: Partial<T> = { ...item };
  delete copy.id;
  return copy as Omit<T, "id">;
}

export function deletePreset(id: string) {
  update((list) => list.filter((p) => p.id !== id));
}

// ---------- Built-in presets ----------

// A built-in agent names a tier of one maker. It resolves against the model
// list the server sends, so a new release of a family takes over on its own.
// With a command line tool named, the tool is used when it is installed, run
// on the model matched in its own list, and the gateway model otherwise.
interface BuiltinAgent {
  tool?: "cli/claude-code" | "cli/codex";
  toolModel?: RegExp; // matched against the tool's own model ids
  api: RegExp; // matched against gateway model ids
}

const CLAUDE_TOP: BuiltinAgent = { tool: "cli/claude-code", toolModel: /^fable$/, api: /^anthropic\/claude-fable/ };
const CLAUDE_GOOD: BuiltinAgent = { tool: "cli/claude-code", toolModel: /^opus$/, api: /^anthropic\/claude-opus/ };
const CODEX_TOP: BuiltinAgent = { tool: "cli/codex", toolModel: /astra/, api: /^openai\/gpt-[\d.]+-astra/ };
const CODEX_GOOD: BuiltinAgent = { tool: "cli/codex", toolModel: /sol/, api: /^openai\/gpt-[\d.]+-sol/ };
const API_CLAUDE_TOP: BuiltinAgent = { api: CLAUDE_TOP.api };
const API_CLAUDE_GOOD: BuiltinAgent = { api: CLAUDE_GOOD.api };
const API_GPT_TOP: BuiltinAgent = { api: CODEX_TOP.api };
const API_GPT_GOOD: BuiltinAgent = { api: CODEX_GOOD.api };
const GEMINI_TOP: BuiltinAgent = { api: /^google\/gemini-[\d.]+-pro/ };
const GEMINI_GOOD: BuiltinAgent = { api: /^google\/gemini-[\d.]+-flash$/ };
const GROK_TOP: BuiltinAgent = { api: /^(?:space)?xai\/grok-[\d.]+$/ };
const GROK_GOOD: BuiltinAgent = { api: /^(?:space)?xai\/grok-[\d.]+-fast/ };

const BUILTIN: Array<{ name: string; agents: BuiltinAgent[] }> = [
  { name: "Coding agents · Top tier", agents: [CLAUDE_TOP, CODEX_TOP] },
  { name: "Coding agents · Good tier", agents: [CLAUDE_GOOD, CODEX_GOOD] },
  { name: "Hybrid four · Top tier", agents: [CLAUDE_TOP, CODEX_TOP, GEMINI_TOP, GROK_TOP] },
  { name: "Hybrid four · Good tier", agents: [CLAUDE_GOOD, CODEX_GOOD, GEMINI_GOOD, GROK_GOOD] },
  { name: "Big 4 API · Top tier", agents: [API_CLAUDE_TOP, API_GPT_TOP, GEMINI_TOP, GROK_TOP] },
  { name: "Big 4 API · Good tier", agents: [API_CLAUDE_GOOD, API_GPT_GOOD, GEMINI_GOOD, GROK_GOOD] },
];

// The built-in presets that the current model list can fill completely.
// Each comes with the Summarizer arbiter on the default arbiter model.
export function builtinPresets(data: ModelsResponse): Preset[] {
  const arbiter = summarizer(data);
  const out: Preset[] = [];
  BUILTIN.forEach((entry, i) => {
    const seats = entry.agents.map((agent) => resolveAgent(agent, data.models));
    if (seats.some((s) => s === null)) return;
    out.push({
      id: `builtin-${i + 1}`,
      name: entry.name,
      createdAt: 0,
      interaction: "group",
      turns: "parallel",
      instructions: "",
      seats: seats as Array<Omit<Seat, "id">>,
      arbiters: arbiter ? [arbiter] : [],
    });
  });
  return out;
}

export function isBuiltinPreset(preset: Preset): boolean {
  return preset.id.startsWith("builtin-");
}

function resolveAgent(agent: BuiltinAgent, models: ModelInfo[]): Omit<Seat, "id"> | null {
  const tool = agent.tool ? models.find((m) => m.id === agent.tool) : undefined;
  if (tool) {
    const toolModel = agent.toolModel ? tool.toolModels?.find((t) => agent.toolModel?.test(t.id))?.id : undefined;
    return { modelId: tool.id, modelName: tool.name, maker: tool.maker, browsing: true, ...(toolModel ? { toolModel } : {}) };
  }
  const api = models.find((m) => !m.id.startsWith("cli/") && agent.api.test(m.id));
  if (!api) return null;
  return { modelId: api.id, modelName: api.name, maker: api.maker, browsing: true };
}

function summarizer(data: ModelsResponse): Omit<Arbiter, "id"> | null {
  const model = data.models.find((m) => m.id === data.defaults.arbiter) ?? data.models[0];
  if (!model) return null;
  return {
    name: SUMMARIZER_NAME,
    modelId: model.id,
    modelName: model.name,
    maker: model.maker,
    browsing: false,
    instructions: SUMMARIZER_INSTRUCTIONS,
  };
}

// The edit that gives a table this setup. Agents get letters A, B, C in order.
export function applyPreset(preset: Preset): TableEdit {
  return {
    interaction: preset.interaction,
    turns: preset.turns ?? "parallel",
    instructions: preset.instructions ?? "",
    seats: preset.seats.slice(0, SEAT_LETTERS.length).map((seat, i) => ({ ...seat, id: SEAT_LETTERS[i] })),
    arbiters: preset.arbiters.map((arbiter, i) => ({ ...arbiter, id: `arbiter-${i + 1}` })),
  };
}
