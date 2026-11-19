// The model list for /api/models, with defaults for a new table.
//
// The gateway offers well over a hundred models. The picker shows a short
// list instead: the newest model in each of a few families per maker, from
// the top tier down to the small, fast tier. The families are matched by
// name, with version numbers removed, so a new release of a family replaces
// the old one on its own. If a maker renames everything, the three newest
// models from that maker are shown instead.
//
// With a gateway key, the list comes from the gateway. With provider keys
// only, it comes from the gateway's public list, limited to the makers that
// have a key. Claude Code and Codex, when installed on this machine, come
// first in the list, and without any key they are the whole list. Claude Code
// offers its model aliases, and Codex offers the OpenAI models from the short
// list.
//
// Each model carries the thinking levels it offers. For gateway models they
// come from the public list, which names them for every model; Claude Code
// and Codex get theirs from lib/server/cliTools.ts.
//
// On a fresh install the response also says needsSetup: true, so the app
// shows the first-run setup dialog. That is when no key is set in the
// settings file or the environment, the host has not finished or skipped the
// setup, and CONSORTIUM_MOCK is not set. Installed tools do not change it,
// since the dialog's first step shows the tools that were found.

import type { Maker, ModelInfo, ModelsResponse } from "@/lib/types";
import { CLAUDE_CODE_ID, clearCliToolCache, cliModelInfos, getCliTools, isThinkingLevel, type CliTool } from "./cliTools";
import { isForcedMock } from "./env";
import { gatewayProvider } from "./gatewayClient";
import { hasAnyModelKey, makersWithKeys, readSettingsFile, resolveKeys, type ResolvedKeys, type SettingsFile } from "./settings";

const CACHE_MS = 10 * 60 * 1000;
const MAKER_ORDER: Maker[] = ["anthropic", "openai", "google", "xai"];
const FALLBACK_PER_MAKER = 3;

// The gateway lists xAI models under "xai/" or "spacexai/".
const PREFIXES: Array<[string, Maker]> = [
  ["anthropic/", "anthropic"],
  ["openai/", "openai"],
  ["google/", "google"],
  ["xai/", "xai"],
  ["spacexai/", "xai"],
];

interface Family {
  match: RegExp; // tested against the id with version numbers removed
  seatDefault?: boolean; // the model a new table starts with, for this maker
  arbiter?: boolean; // the model a new arbiter starts with, for this maker
}

// Families per maker, from the highest tier to the lowest.
const FAMILIES: Record<Maker, Family[]> = {
  anthropic: [
    { match: /^anthropic\/claude-fable$/ },
    { match: /^anthropic\/claude-opus$/, arbiter: true },
    { match: /^anthropic\/claude-sonnet$/, seatDefault: true },
    { match: /^anthropic\/claude-haiku$/ },
  ],
  openai: [
    { match: /^openai\/gpt-astra$/ },
    { match: /^openai\/gpt-sol$/, seatDefault: true },
    { match: /^openai\/gpt-terra$/ },
    { match: /^openai\/gpt-luna$/ },
  ],
  // Gemini 4 replaced Gemini Pro with four named models. Flash and Flash Lite
  // are still the fast tiers.
  google: [
    { match: /^google\/gemini-neon$/ },
    { match: /^google\/gemini-carbon$/, seatDefault: true },
    { match: /^google\/gemini-argon$/ },
    { match: /^google\/gemini-hydrogen$/ },
    { match: /^google\/gemini-flash$/ },
    { match: /^google\/gemini-flash-lite$/ },
  ],
  xai: [
    { match: /^(?:space)?xai\/grok$/, seatDefault: true },
    { match: /^(?:space)?xai\/grok-fast-reasoning$/ },
  ],
};

// Thinking levels as the public list gives them for the built-in models.
const TOP_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const TOP_LEVELS_WITH_NONE = ["none", ...TOP_LEVELS];
const TO_XHIGH = ["low", "medium", "high", "xhigh"];
const TO_HIGH = ["low", "medium", "high"];

// The built-in list for mock mode, used when the public model list cannot
// be fetched. The ids are real gateway ids, so a table made in mock mode
// keeps working after a key is added. The thinking levels are the ones the
// public list gave for each model.
export const MOCK_MODELS: ModelInfo[] = [
  { id: "anthropic/claude-fable-5.2", name: "Claude Fable 5.2", maker: "anthropic", thinkingLevels: TOP_LEVELS },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", maker: "anthropic", thinkingLevels: TOP_LEVELS },
  { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", maker: "anthropic", thinkingLevels: TOP_LEVELS },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", maker: "anthropic", thinkingLevels: TOP_LEVELS_WITH_NONE },
  { id: "openai/gpt-6.2-astra", name: "GPT-6.2 Astra", maker: "openai", thinkingLevels: TOP_LEVELS },
  { id: "openai/gpt-6.2-sol", name: "GPT-6.2 Sol", maker: "openai", thinkingLevels: TOP_LEVELS },
  { id: "openai/gpt-6.1-terra", name: "GPT-6.1 Terra", maker: "openai", thinkingLevels: TOP_LEVELS_WITH_NONE },
  { id: "openai/gpt-6-luna", name: "GPT-6 Luna", maker: "openai", thinkingLevels: TOP_LEVELS_WITH_NONE },
  { id: "google/gemini-4-neon", name: "Gemini 4 Neon", maker: "google", thinkingLevels: TO_XHIGH },
  { id: "google/gemini-4-carbon", name: "Gemini 4 Carbon", maker: "google", thinkingLevels: TO_HIGH },
  { id: "google/gemini-4-argon", name: "Gemini 4 Argon", maker: "google", thinkingLevels: TO_HIGH },
  { id: "google/gemini-4-hydrogen", name: "Gemini 4 Hydrogen", maker: "google", thinkingLevels: TO_XHIGH },
  { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", maker: "google", thinkingLevels: TO_HIGH },
  { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", maker: "google", thinkingLevels: ["minimal", ...TO_HIGH] },
  { id: "spacexai/grok-4.7", name: "Grok 4.7", maker: "xai", thinkingLevels: TO_XHIGH },
];

// The gateway list for one key, and the public list (null when it could not
// be fetched), each kept for 10 minutes.
let gatewayCache: { at: number; key: string; value: ModelsResponse } | null = null;
let publicCache: { at: number; entries: GatewayEntry[] | null } | null = null;

export function makerOf(id: string): Maker | null {
  for (const [prefix, maker] of PREFIXES) if (id.startsWith(prefix)) return maker;
  return null;
}

export function mockModelsResponse(entries?: GatewayEntry[]): ModelsResponse {
  const fromEntries = entries ? buildModelsResponse(entries).models : [];
  const curated = fromEntries.length > 0 ? fromEntries : curate(MOCK_MODELS).models;
  return { mock: true, models: curated, defaults: curate(curated).defaults };
}

// The gateway publishes its model list without a key. Mock mode uses it so
// the picker stays current, and falls back to the built-in list offline.
const PUBLIC_LIST_URL = "https://ai-gateway.vercel.sh/v1/models";

export async function fetchPublicModelList(fetchFn: typeof fetch = fetch): Promise<GatewayEntry[]> {
  const response = await fetchFn(PUBLIC_LIST_URL, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`The public model list returned status ${response.status}.`);
  const body = (await response.json()) as {
    data?: Array<{ id?: unknown; name?: unknown; type?: unknown; released?: unknown; reasoning_options?: unknown }>;
  };
  if (!Array.isArray(body.data)) throw new Error("The public model list had no data.");
  return body.data
    .filter((m) => typeof m.id === "string")
    .map((m) => ({
      id: m.id as string,
      name: typeof m.name === "string" ? m.name : (m.id as string),
      modelType: typeof m.type === "string" ? m.type : null,
      released: typeof m.released === "number" ? m.released : null,
      thinkingLevels: effortLevels(m.reasoning_options),
    }));
}

// The public list describes a model's reasoning settings, for example
// [{"type":"toggle"},{"type":"effort","values":["none","low","high"]}].
// The values of the "effort" entry are the levels, in order. Other kinds,
// such as a token budget, offer no levels to choose from.
export function effortLevels(options: unknown): string[] | null {
  if (!Array.isArray(options)) return null;
  const effort = options.find(
    (o): o is { values: unknown[] } => typeof o === "object" && o !== null && o.type === "effort" && Array.isArray(o.values),
  );
  if (!effort) return null;
  const levels: string[] = [];
  for (const value of effort.values) {
    if (isThinkingLevel(value) && !levels.includes(value)) levels.push(value);
  }
  return levels.length > 0 ? levels : null;
}

export interface ModelsOptions {
  now?: number;
  tools?: CliTool[]; // the installed tools; detected on this machine when absent
  keys?: ResolvedKeys; // the keys in use; read from the settings and the environment when absent
  settings?: SettingsFile; // the settings file; read from disk when absent
}

// The gateway part of the list is cached for 10 minutes. The tool entries are
// added on every request, so a model seen in a real call shows at once.
export async function getModelsResponse({ now = Date.now(), tools, keys, settings }: ModelsOptions = {}): Promise<ModelsResponse> {
  const found = tools ?? getCliTools(now);

  // CONSORTIUM_MOCK=1: sample replies for everything, so no key is read.
  if (isForcedMock()) {
    const sample = await sampleList(now);
    return withTools(sample, found);
  }

  const file = settings ?? readSettingsFile();
  const resolved = keys ?? resolveKeys(file);
  const gatewayKey = resolved.gateway?.value;
  if (gatewayKey) {
    const base = await gatewayList(now, gatewayKey);
    return withTools(base, found);
  }

  // Provider keys only: the public list, limited to the makers with a key.
  // Codex still gets the OpenAI models from the full list.
  const makers = makersWithKeys(resolved);
  if (makers.length > 0) {
    const base = await providerList(now, makers);
    return withTools(base, found);
  }

  // No key: the installed tools are the whole list. The public gateway list is
  // read only to offer Codex its models. With no tools, the app stays in
  // sample mode. Either way the first-run setup is offered until it is done.
  const needsSetup = !hasAnyModelKey(resolved) && file.setupDone !== true;
  if (found.length > 0) {
    const installed = cliModelInfos(found);
    const ids = installed.map((m) => m.id);
    return {
      mock: false,
      models: installed,
      defaults: { seats: ids, arbiter: found.some((t) => t.id === CLAUDE_CODE_ID) ? CLAUDE_CODE_ID : ids[0] },
      needsSetup,
    };
  }
  return { ...(await sampleList(now)), needsSetup };
}

// The installed tools come first and are the default agents, since they run
// on the host's subscriptions. Claude Code is the default arbiter when
// installed; otherwise it stays a gateway model.
function withTools(base: ModelsResponse, found: CliTool[]): ModelsResponse {
  const installed = cliModelInfos(found);
  if (installed.length === 0) return base;
  const defaults = {
    seats: installed.map((m) => m.id),
    arbiter: found.some((t) => t.id === CLAUDE_CODE_ID) ? CLAUDE_CODE_ID : base.defaults.arbiter,
  };
  return { ...base, models: [...installed, ...base.models], defaults };
}

// The gateway's own list for a key does not say which thinking levels a model
// offers, so they come from the public list by id, or from the built-in list
// when the public one cannot be read.
async function gatewayList(now: number, key: string): Promise<ModelsResponse> {
  if (gatewayCache && gatewayCache.key === key && now - gatewayCache.at < CACHE_MS) return gatewayCache.value;
  const [{ models }, publicList] = await Promise.all([gatewayProvider(key).getAvailableModels(), publicEntries(now)]);
  const levels = new Map<string, string[]>();
  for (const entry of publicList ?? MOCK_MODELS) {
    if (entry.thinkingLevels?.length) levels.set(entry.id, entry.thinkingLevels);
  }
  const value = buildModelsResponse(models.map((m) => ({ ...m, thinkingLevels: levels.get(m.id) ?? null })));
  gatewayCache = { at: now, key, value };
  return value;
}

async function publicEntries(now: number): Promise<GatewayEntry[] | null> {
  if (publicCache && now - publicCache.at < CACHE_MS) return publicCache.entries;
  let entries: GatewayEntry[] | null = null;
  try {
    entries = await fetchPublicModelList();
  } catch (err) {
    console.warn("Could not fetch the public model list, so the built-in sample list is used.", err);
  }
  publicCache = { at: now, entries };
  return entries;
}

// The list for sample mode, also the source of Codex's choices without a gateway key.
async function sampleList(now: number): Promise<ModelsResponse> {
  return mockModelsResponse((await publicEntries(now)) ?? undefined);
}

// The models of the makers with a key, from the public list, or from the
// built-in list when the public list cannot be read.
async function providerList(now: number, makers: Maker[]): Promise<ModelsResponse> {
  const keep = (id: string) => {
    const maker = makerOf(id);
    return maker !== null && makers.includes(maker);
  };
  const entries = (await publicEntries(now)) ?? [];
  const fromList = buildModelsResponse(entries.filter((e) => keep(e.id)));
  if (fromList.models.length > 0) return fromList;
  return buildModelsResponse(
    MOCK_MODELS.filter((m) => keep(m.id)).map((m) => ({ id: m.id, name: m.name, thinkingLevels: m.thinkingLevels })),
  );
}

export function clearModelsCache(): void {
  gatewayCache = null;
  publicCache = null;
  clearCliToolCache();
}

export interface GatewayEntry {
  id: string;
  name: string;
  modelType?: string | null;
  released?: number | null; // unix seconds, when the gateway provides it
  thinkingLevels?: string[] | null; // the model's thinking levels, in order
}

type Candidate = ModelInfo & { released?: number | null };

export function buildModelsResponse(entries: GatewayEntry[]): ModelsResponse {
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (entry.modelType && entry.modelType !== "language") continue;
    if (isImageModel(entry)) continue;
    const maker = makerOf(entry.id);
    if (!maker) continue;
    candidates.push({
      id: entry.id,
      name: entry.name || entry.id,
      maker,
      released: entry.released ?? null,
      ...(entry.thinkingLevels?.length ? { thinkingLevels: entry.thinkingLevels } : {}),
    });
  }
  const { models, defaults } = curate(candidates);
  return { mock: false, models, defaults };
}

// The gateway lists some image-generation models with type "language", for
// example google/gemini-2.5-flash-image. Seats cannot use them. Batch
// variants, such as anthropic/claude-opus-5.5-batch, answer hours later, so
// they are left out too.
function isImageModel(entry: GatewayEntry): boolean {
  return entry.id.includes("-image") || (entry.name ?? "").includes("Image") || isBatchModel(entry);
}

function isBatchModel(entry: GatewayEntry): boolean {
  return entry.id.endsWith("-batch") || /\bbatch\b/i.test(entry.name ?? "");
}

// ---------- Choosing the short list ----------

// "anthropic/claude-opus-5.5" becomes "anthropic/claude-opus", and
// "openai/gpt-6.1-sol" becomes "openai/gpt-sol".
export function familyOf(id: string): string {
  return id.replace(/-?\d+(?:\.\d+)*/g, "").replace(/--+/g, "-");
}

// Picks the newest model in each family, in tier order, plus the defaults.
export function curate(candidates: Candidate[]): { models: ModelInfo[]; defaults: ModelsResponse["defaults"] } {
  const models: ModelInfo[] = [];
  const seats: string[] = [];
  let arbiter: string | null = null;

  for (const maker of MAKER_ORDER) {
    const own = candidates.filter((m) => m.maker === maker);
    if (own.length === 0) continue;

    const chosen: ModelInfo[] = [];
    let seatDefault: string | null = null;
    for (const family of FAMILIES[maker]) {
      const newest = newestOf(own.filter((m) => family.match.test(familyOf(m.id))));
      if (!newest) continue;
      chosen.push(strip(newest));
      if (family.seatDefault) seatDefault = newest.id;
      if (family.arbiter && !arbiter) arbiter = newest.id;
    }

    if (chosen.length === 0) {
      // Nothing matched, so the maker has renamed its models. Show the newest few.
      const newestFirst = [...own].sort(compareNewest).slice(0, FALLBACK_PER_MAKER);
      chosen.push(...newestFirst.map(strip));
    }

    models.push(...chosen);
    seats.push(seatDefault ?? chosen[0].id);
  }

  // Without Claude Opus, an arbiter starts on the first maker's seat default.
  return { models, defaults: { seats, arbiter: arbiter ?? seats[0] ?? "" } };
}

function strip(candidate: Candidate): ModelInfo {
  const model: ModelInfo = { id: candidate.id, name: candidate.name, maker: candidate.maker };
  if (candidate.thinkingLevels?.length) model.thinkingLevels = [...candidate.thinkingLevels];
  return model;
}

function newestOf(candidates: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (!best || compareNewest(candidate, best) < 0) best = candidate;
  }
  return best;
}

// Sorts newer models first: by release date when both have one, otherwise by
// the version number in the id.
function compareNewest(a: Candidate, b: Candidate): number {
  if (a.released && b.released && a.released !== b.released) return b.released - a.released;
  return compareVersions(versionOf(b.id), versionOf(a.id));
}

function versionOf(id: string): number[] {
  const match = /\d+(?:\.\d+)*/.exec(id.slice(id.indexOf("/") + 1));
  return match ? match[0].split(".").map(Number) : [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Kept for callers that only have a plain list, such as tests.
export function pickDefaults(models: ModelInfo[]): ModelsResponse["defaults"] {
  return curate(models).defaults;
}
