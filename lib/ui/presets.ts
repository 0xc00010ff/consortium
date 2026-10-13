"use client";

// Saved Participants setups. A preset holds the interaction, turns, system
// prompt, agents and arbiters of a table, without their ids. All presets are
// one JSON array in localStorage, so every tab shares them; the "storage"
// event brings in another tab's changes.

import { useSyncExternalStore } from "react";
import {
  SEAT_LETTERS,
  type Arbiter,
  type Interaction,
  type ModelInfo,
  type ModelsResponse,
  type Seat,
  type Table,
  type TableEdit,
  type Turns,
} from "@/lib/types";
import { SUMMARIZER_INSTRUCTIONS, SUMMARIZER_NAME } from "./engine";
import { uid } from "./format";
import { createStore, isQuotaError, PREFIX, storageWarningStore } from "./storage";

export const PRESETS_KEY = `${PREFIX}presets`;

export interface Preset {
  id: string;
  name: string;
  createdAt: number;
  interaction: Interaction;
  turns?: Turns;
  instructions?: string;
  seats: Array<Omit<Seat, "id">>;
  arbiters: Array<Omit<Arbiter, "id">>;
}

const EMPTY: Preset[] = [];

// The stored list, or null when storage cannot be read.
function readStored(): Preset[] | null {
  try {
    const raw = window.localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Preset[]) : [];
  } catch {
    return null;
  }
}

let bound = false;
function bindStorageEvent() {
  if (bound || typeof window === "undefined") return;
  bound = true;
  window.addEventListener("storage", (e) => {
    if (e.storageArea !== window.localStorage) return;
    if (e.key !== null && e.key !== PRESETS_KEY) return;
    const stored = readStored();
    if (stored) presetsStore.set(stored);
  });
}

const presetsStore = createStore<Preset[]>(() => {
  bindStorageEvent();
  return readStored() ?? EMPTY;
}, EMPTY);

// The warning this file raised, so it is cleared only if it is still showing.
let shownWarning: string | null = null;

// Applies a change to the stored list, so presets another tab added are kept.
// The change shows here even when it cannot be written.
function update(change: (list: Preset[]) => Preset[], name: string) {
  const next = change(readStored() ?? presetsStore.get());
  presetsStore.set(next);
  try {
    window.localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
    if (shownWarning && storageWarningStore.get() === shownWarning) storageWarningStore.set(null);
    shownWarning = null;
  } catch (err) {
    if (storageWarningStore.get()) return; // a table's warning already covers it
    shownWarning = isQuotaError(err)
      ? `Browser storage is full, so the preset “${name}” is not saved. Delete older tables from the list on the left to make room.`
      : `The preset “${name}” could not be saved in the browser. It will be lost when you close the page.`;
    storageWarningStore.set(shownWarning);
  }
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
  update((list) => {
    const at = list.findIndex((p) => p.name === clean);
    if (at === -1) return [...list, { id: uid(), name: clean, createdAt: Date.now(), ...setup }];
    return list.map((p, i) => (i === at ? { ...p, ...setup } : p));
  }, clean);
}

function withoutId<T extends { id: string }>(item: T): Omit<T, "id"> {
  const copy: Partial<T> = { ...item };
  delete copy.id;
  return copy as Omit<T, "id">;
}

export function deletePreset(id: string) {
  const name = presetsStore.get().find((p) => p.id === id)?.name ?? "";
  update((list) => list.filter((p) => p.id !== id), name);
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
