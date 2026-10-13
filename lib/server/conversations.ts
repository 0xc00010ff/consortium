// Saved conversations: one JSON file per conversation in
// ~/.consortium/conversations/<id>.json (or $CONSORTIUM_HOME/conversations/).
// Each file holds a Table, the type the browser uses for a conversation. The
// browser owns its shape, so the server checks only the fields it lists and
// compares by.
//
// The list of summaries is cached in memory. A write or delete through this
// module clears the cache, and a listing rescans the folder when the folder
// changed or the cache is more than five seconds old, so a conversation written by
// another process shows up.

import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Table, TableSummary } from "@/lib/types";
import { isRecord, writeFileAtomic } from "./files";
import { settingsDir, type Env } from "./settings";

export const MAX_CONVERSATION_BYTES = 20 * 1024 * 1024;
export const LIST_CACHE_MS = 5000;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export const INVALID_ID_ERROR = "A conversation id must be 1 to 80 letters, digits, hyphens or underscores.";

export function isValidConversationId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function conversationsDir(env: Env = process.env): string {
  return path.join(settingsDir(env), "conversations");
}

function conversationPath(id: string): string {
  if (!isValidConversationId(id)) throw new Error(INVALID_ID_ERROR);
  return path.join(conversationsDir(), `${id}.json`);
}

// ---------- Checking a conversation ----------

export type CheckedConversation = { ok: true; table: Table } | { ok: false; error: string };

// Checks the fields the server relies on. Deeper fields are left to the
// browser, which wrote them.
export function checkConversation(value: unknown, id?: string): CheckedConversation {
  if (!isRecord(value)) return { ok: false, error: "The conversation must be a JSON object." };
  if (!isValidConversationId(value.id)) return { ok: false, error: INVALID_ID_ERROR };
  if (id !== undefined && value.id !== id) {
    return { ok: false, error: "The conversation id in the body does not match the id in the address." };
  }
  if (typeof value.title !== "string") return { ok: false, error: "The conversation title must be a string." };
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
      return { ok: false, error: `The conversation's ${field} must be a number.` };
    }
  }
  for (const field of ["seats", "arbiters", "rounds"] as const) {
    if (!Array.isArray(value[field])) return { ok: false, error: `The conversation's ${field} must be a list.` };
  }
  if (!isRecord(value.privateThreads)) return { ok: false, error: "The conversation's privateThreads must be an object." };
  return { ok: true, table: value as unknown as Table };
}

function summarize(table: Table): TableSummary {
  return { id: table.id, title: table.title, createdAt: table.createdAt, updatedAt: table.updatedAt };
}

function newestFirst(a: TableSummary, b: TableSummary): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

// ---------- The summary cache ----------

interface ListCache {
  dir: string;
  dirMtimeMs: number;
  scannedAt: number;
  summaries: TableSummary[];
}

// Next.js bundles each route on its own, so a plain module variable would give
// each route its own cache. Keeping it on globalThis shares it across routes
// in the same server process.
const CACHE_KEY = Symbol.for("consortium.conversations.listCache");
type CacheHolder = { [CACHE_KEY]?: ListCache | null };

function getCache(): ListCache | null {
  return (globalThis as CacheHolder)[CACHE_KEY] ?? null;
}

function setCache(cache: ListCache | null): void {
  (globalThis as CacheHolder)[CACHE_KEY] = cache;
}

export function clearConversationsCache(): void {
  setCache(null);
}

function dirMtime(dir: string): number {
  try {
    return statSync(/*turbopackIgnore: true*/ dir).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------- Reading and writing ----------

// Reads one file as a conversation, or null when it is missing or malformed.
function readConversationFile(file: string, id: string): Table | null {
  let text: string;
  try {
    // The folder is outside the project, so the build should not trace it.
    text = readFileSync(/*turbopackIgnore: true*/ file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Could not read the saved conversation ${file}.`, err);
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn(`Skipping the saved conversation ${file}, because it is not valid JSON.`);
    return null;
  }
  const checked = checkConversation(raw, id);
  if (!checked.ok) {
    console.warn(`Skipping the saved conversation ${file}. ${checked.error}`);
    return null;
  }
  return checked.table;
}

// Every saved conversation's summary, newest first by updatedAt. A malformed file is
// skipped with a warning.
export function listConversations(): TableSummary[] {
  const dir = conversationsDir();
  const mtime = dirMtime(dir);
  const cache = getCache();
  if (cache && cache.dir === dir && cache.dirMtimeMs === mtime && Date.now() - cache.scannedAt <= LIST_CACHE_MS) {
    return cache.summaries.slice();
  }

  let names: string[];
  try {
    names = readdirSync(/*turbopackIgnore: true*/ dir);
  } catch {
    names = [];
  }
  const summaries: TableSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isValidConversationId(id)) continue;
    const table = readConversationFile(path.join(dir, name), id);
    if (table) summaries.push(summarize(table));
  }
  summaries.sort(newestFirst);
  setCache({ dir, dirMtimeMs: mtime, scannedAt: Date.now(), summaries });
  return summaries.slice();
}

// The saved conversation, or null when there is none. Throws on an invalid id.
export function readConversation(id: string): Table | null {
  return readConversationFile(conversationPath(id), id);
}

// Saves the conversation to <id>.json, creating the folder with mode 0700 and the
// file with mode 0600. Throws when it fails checkConversation.
export function writeConversation(table: Table): TableSummary {
  const checked = checkConversation(table);
  if (!checked.ok) throw new Error(checked.error);
  writeFileAtomic(conversationPath(table.id), JSON.stringify(table));
  clearConversationsCache();
  return summarize(table);
}

// Removes the saved conversation. Removing one that is not saved does nothing.
export function deleteConversation(id: string): void {
  rmSync(conversationPath(id), { force: true });
  clearConversationsCache();
}
