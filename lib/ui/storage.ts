// The browser's link to the saved tables on the server. The server keeps each
// table on disk (see app/api/conversations), and this module keeps a small
// cache: the list of summaries for the sidebar, which reloads every 5 seconds
// while the page is visible. Writes are throttled by the caller through
// createSaver, and tables.ts decides what to do with conflicts.
//
// Tables used to live in localStorage. On the first load after the move, any
// table still there is sent to the server once and then removed.

import type { Table, TableResponse, TableSummary, TablesResponse } from "@/lib/types";

export type { TableSummary };

export const PREFIX = "consortium.v2.";
const OLD_INDEX_KEY = `${PREFIX}index`;
const OLD_TABLE_PREFIX = `${PREFIX}table.`;
const OLD_V1_PREFIX = "consortium.v1.";
const API = "/api/conversations";
const POLL_MS = 5000;
// Browsers refuse a keepalive request with a larger body.
const KEEPALIVE_LIMIT = 60_000;

export const STOPPED = "Stopped";

// ---------- small external stores for React ----------

type Listener = () => void;

export function createStore<T>(initial: () => T, server: T) {
  let value: T | undefined;
  const listeners = new Set<Listener>();
  return {
    get(): T {
      if (value === undefined) value = initial();
      return value;
    },
    set(next: T) {
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    server: () => server,
  };
}

// ---------- talking to the server ----------

const UNREACHABLE = "Check that the server is running.";

// A failed request. Status 0 means the server could not be reached.
class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new RequestError(0, UNREACHABLE);
  }
}

export async function errorFrom(res: Response): Promise<RequestError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new RequestError(res.status, body?.error || `The server answered with status ${res.status}.`);
}

function isUnreachable(err: unknown): boolean {
  return err instanceof RequestError && err.status === 0;
}

// "Could not save the conversation." followed by what went wrong.
export function describeFailure(what: string, err: unknown): string {
  if (isUnreachable(err)) return `${what} ${UNREACHABLE}`;
  const detail = err instanceof Error && err.message ? err.message : "The request failed.";
  return `${what} ${detail}`;
}

function tableUrl(id: string, force = false): string {
  return `${API}/${encodeURIComponent(id)}${force ? "?force=1" : ""}`;
}

// ---------- the storage warning ----------

// A plain message shown when loading or saving fails, or null when all is
// well. Each source (the list, one table, the presets) raises and clears its
// own warning, and the newest one shows.
export const storageWarningStore = createStore<string | null>(() => null, null);
const warnings = new Map<string, string>();

export function setWarning(source: string, message: string | null) {
  warnings.delete(source);
  if (message) warnings.set(source, message);
  const newest = [...warnings.values()].at(-1) ?? null;
  if (storageWarningStore.get() !== newest) storageWarningStore.set(newest);
}

// ---------- the list of saved tables ----------

const EMPTY_INDEX: TableSummary[] = [];
const removedIds = new Set<string>(); // deleted here, so a late answer does not bring them back
const changedHereAt = new Map<string, number>(); // when this page last saved or renamed each table

export const indexStore = createStore<TableSummary[]>(() => {
  startSync();
  return EMPTY_INDEX;
}, EMPTY_INDEX);

function setIndex(list: TableSummary[]) {
  const next = list.filter((s) => !removedIds.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  const current = indexStore.get();
  const same =
    next.length === current.length &&
    next.every((s, i) => s.id === current[i].id && s.title === current[i].title && s.updatedAt === current[i].updatedAt);
  if (!same) indexStore.set(next);
}

function upsertSummary(summary: TableSummary) {
  changedHereAt.set(summary.id, Date.now());
  setIndex([summary, ...indexStore.get().filter((s) => s.id !== summary.id)]);
}

// The server's list, and when the request for it began.
export interface IndexSnapshot {
  tables: TableSummary[];
  startedAt: number;
}

let loading: Promise<IndexSnapshot | null> | null = null;

// Loads the list from the server. Resolves to null when that failed.
export function reloadIndex(): Promise<IndexSnapshot | null> {
  if (loading) return loading;
  const startedAt = Date.now();
  loading = (async () => {
    try {
      const res = await request(API);
      if (!res.ok) throw await errorFrom(res);
      const { tables } = (await res.json()) as TablesResponse;
      // A save made here after the request began is newer than the answer.
      const byId = new Map(tables.map((s) => [s.id, s]));
      for (const s of indexStore.get()) {
        const fetched = byId.get(s.id);
        if ((changedHereAt.get(s.id) ?? 0) >= startedAt && (!fetched || fetched.updatedAt < s.updatedAt)) byId.set(s.id, s);
      }
      setIndex([...byId.values()]);
      setWarning("index", null);
      return { tables, startedAt };
    } catch (err) {
      setWarning("index", describeFailure("Could not load your conversations.", err));
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

// ---------- polling ----------

// tables.ts and presets.ts listen here to bring in changes from other tabs.
const refreshListeners = new Set<(snapshot: IndexSnapshot | null) => void>();

export function onRefresh(listener: (snapshot: IndexSnapshot | null) => void) {
  refreshListeners.add(listener);
}

async function refresh() {
  const snapshot = await reloadIndex();
  refreshListeners.forEach((l) => l(snapshot));
}

let started = false;

// Loads the list, moves any tables left in localStorage to the server, then
// reloads every 5 seconds while the page is visible.
export function startSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  removeV1Keys();
  void (async () => {
    const first = await reloadIndex();
    if (first && oldTableKeys().length) {
      await migrateTables(first.tables);
      await reloadIndex();
    }
  })();
  window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
}

// ---------- read, write, delete ----------

export type WriteResult =
  | { status: "saved"; summary: TableSummary }
  | { status: "conflict"; saved: Table } // the saved copy is newer
  | { status: "failed" };

// The table on the server, or null when there is none. Throws when the server
// cannot be reached or answers with an error.
export async function readTable(id: string): Promise<Table | null> {
  const res = await request(tableUrl(id));
  if (res.status === 404) return null;
  if (!res.ok) throw await errorFrom(res);
  const { table } = (await res.json()) as TableResponse;
  return table?.id ? normalizeTable(table) : null;
}

// Saves the whole table. A failure raises the warning, and the next save that
// works clears it.
export async function writeTable(table: Table, { force = false } = {}): Promise<WriteResult> {
  const body = JSON.stringify({ table } satisfies TableResponse);
  try {
    const res = await request(tableUrl(table.id, force), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: leaving && body.length < KEEPALIVE_LIMIT,
    });
    if (res.status === 409 && !force) {
      const { table: saved } = (await res.json()) as TableResponse;
      return { status: "conflict", saved: normalizeTable(saved) };
    }
    if (!res.ok) throw await errorFrom(res);
    const { summary } = (await res.json()) as { summary: TableSummary };
    setWarning(`table:${table.id}`, null);
    if (!removedIds.has(table.id)) upsertSummary(summary);
    return { status: "saved", summary };
  } catch (err) {
    setWarning(`table:${table.id}`, describeFailure("Could not save the conversation.", err));
    return { status: "failed" };
  }
}

// Shows a new title in the list before the save that carries it finishes.
export function renameInIndex(id: string, title: string) {
  const summary = indexStore.get().find((s) => s.id === id);
  if (summary) upsertSummary({ ...summary, title, updatedAt: Date.now() });
}

// Removes the table from the list at once, then from the server once any
// save still in flight has finished. Resolves to false when the delete failed,
// in which case the table comes back on the next reload.
export async function removeTable(id: string, after?: Promise<unknown> | null): Promise<boolean> {
  removedIds.add(id);
  setIndex(indexStore.get());
  setWarning(`table:${id}`, null);
  setWarning(`delete:${id}`, null);
  await after?.catch(() => {});
  try {
    const res = await request(tableUrl(id), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw await errorFrom(res);
    return true;
  } catch (err) {
    removedIds.delete(id);
    setWarning(`delete:${id}`, describeFailure("Could not delete the conversation.", err));
    return false;
  } finally {
    void reloadIndex();
  }
}

// The store marks anything that was still running as stopped when it opens
// a table. This only fills in fields an older saved copy may lack.
function normalizeTable(table: Table): Table {
  return { ...table, arbiters: table.arbiters ?? [], rounds: table.rounds ?? [], privateThreads: table.privateThreads ?? {} };
}

// ---------- moving tables out of localStorage ----------

function oldTableKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(OLD_TABLE_PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function removeKey(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage is unavailable. The key is tried again next time.
  }
}

// Sends each table the server does not have yet, and removes the local copy
// once the server holds it. When the server cannot be reached, the rest wait
// for the next page load.
async function migrateTables(onServer: TableSummary[]) {
  const have = new Set(onServer.map((s) => s.id));
  for (const key of oldTableKeys()) {
    let table: Table | null = null;
    try {
      const saved = JSON.parse(window.localStorage.getItem(key) ?? "null") as { table?: Table } | null;
      if (saved?.table?.id) table = normalizeTable(saved.table);
    } catch {
      table = null; // unreadable, so nothing could open it
    }
    if (!table || have.has(table.id)) {
      removeKey(key);
      continue;
    }
    try {
      const res = await request(tableUrl(table.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table } satisfies TableResponse),
      });
      // 409 means the server already has a newer copy.
      if (res.ok || res.status === 409) removeKey(key);
      else console.warn(`The saved conversation ${table.id} could not be moved to the server.`, (await errorFrom(res)).message);
    } catch {
      return;
    }
  }
  if (oldTableKeys().length === 0) removeKey(OLD_INDEX_KEY);
}

// Version 1 sessions cannot be opened by this version, so their keys only use space.
function removeV1Keys() {
  try {
    const old: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(OLD_V1_PREFIX)) old.push(key);
    }
    old.forEach(removeKey);
  } catch {
    // Storage is unavailable. Nothing to clean up.
  }
}

// ---------- throttled saving ----------

const pending = new Set<() => void>();
let pagehideBound = false;
let leaving = false; // the page is closing, so saves use keepalive

function bindPagehide() {
  if (pagehideBound || typeof window === "undefined") return;
  pagehideBound = true;
  window.addEventListener("pagehide", () => {
    leaving = true;
    pending.forEach((flush) => flush());
  });
  window.addEventListener("pageshow", () => {
    leaving = false;
  });
}

export interface Saver {
  schedule(): void;
  flush(): void;
  cancel(): void;
}

// Calls save at most once per `delay` ms, always saving the latest state last.
export function createSaver(save: () => void, delay = 1000): Saver {
  bindPagehide();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    pending.delete(flush);
  }

  function flush() {
    cancel();
    last = Date.now();
    save();
  }

  function schedule() {
    if (timer) return;
    const wait = Math.max(0, delay - (Date.now() - last));
    timer = setTimeout(flush, wait);
    pending.add(flush);
  }

  return { schedule, flush, cancel };
}
