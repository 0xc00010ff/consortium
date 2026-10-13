// Saves tables in localStorage. Each table has its own key, and a small index
// lists them for the recent tables list. Writes are throttled by the caller
// through createSaver. When storage is full, the saved copy drops its images.
//
// Several tabs can share this storage. The index is always merged with the
// stored copy before it is written, and the "storage" event tells this tab
// when another tab has written (see tables.ts).

import type { Table } from "@/lib/types";

const PREFIX = "consortium.v2.";
export const INDEX_KEY = `${PREFIX}index`;
const TABLE_PREFIX = `${PREFIX}table.`;
const OLD_PREFIX = "consortium.v1.";
const MAX_INDEX = 100;

export const STOPPED = "Stopped";

export interface TableSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface SavedTable {
  table: Table;
  savedAt: number;
  attachmentsDropped?: boolean;
}

// ---------- small external stores for React ----------

type Listener = () => void;

function createStore<T>(initial: () => T, server: T) {
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

const EMPTY_INDEX: TableSummary[] = [];

// The stored index, or null when storage cannot be read.
function readStoredIndex(): TableSummary[] | null {
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TableSummary[]) : [];
  } catch {
    return null;
  }
}

export const indexStore = createStore<TableSummary[]>(() => {
  removeOldKeys();
  return readStoredIndex() ?? EMPTY_INDEX;
}, EMPTY_INDEX);

// Another tab changed the index.
export function reloadIndex() {
  const stored = readStoredIndex();
  if (stored) indexStore.set(stored);
}

// Applies a change to the stored index, so tables another tab added are kept.
// Tables that fall off the end of the list are removed from storage too,
// since nothing could open them any more.
function updateIndex(change: (list: TableSummary[]) => TableSummary[]) {
  const merged = change(readStoredIndex() ?? indexStore.get()).sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = merged.slice(0, MAX_INDEX);
  indexStore.set(kept);
  try {
    for (const dropped of merged.slice(MAX_INDEX)) window.localStorage.removeItem(TABLE_PREFIX + dropped.id);
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(kept));
  } catch {
    // The index is small. If even this fails, the warning already covers it.
  }
}

// Version 1 sessions cannot be opened by this version, so their keys only use space.
let oldKeysRemoved = false;
function removeOldKeys() {
  if (oldKeysRemoved) return;
  oldKeysRemoved = true;
  try {
    const old: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(OLD_PREFIX)) old.push(key);
    }
    old.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // Storage is unavailable. Nothing to clean up.
  }
}

export function tableIdFromKey(key: string): string | null {
  return key.startsWith(TABLE_PREFIX) ? key.slice(TABLE_PREFIX.length) : null;
}

// ---------- the storage warning ----------

// A plain message shown when saving fails, or null when all is well. It
// belongs to the table that raised it and stays until that table saves.
export const storageWarningStore = createStore<string | null>(() => null, null);
let warning: { tableId: string; table: Table } | null = null;

function raiseWarning(table: Table, message: string) {
  warning = { tableId: table.id, table };
  storageWarningStore.set(message);
}

function clearWarningFor(tableId: string) {
  if (warning?.tableId !== tableId) return;
  warning = null;
  storageWarningStore.set(null);
}

// ---------- attachments ----------

function dropAttachments(table: Table): Table {
  const threads: Table["privateThreads"] = {};
  for (const [id, thread] of Object.entries(table.privateThreads)) {
    threads[id as keyof typeof threads] = thread?.map((m) => (m.attachments?.length ? { ...m, attachments: [] } : m));
  }
  return {
    ...table,
    rounds: table.rounds.map((r) => (r.host.attachments.length ? { ...r, host: { ...r.host, attachments: [] } } : r)),
    privateThreads: threads,
  };
}

function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED" || err.code === 22)
  );
}

// ---------- read and write ----------

// Writes a table and returns the time it was saved, or null when it failed.
export function writeTable(table: Table): number | null {
  const key = TABLE_PREFIX + table.id;
  const savedAt = Date.now();
  let saved: SavedTable = { table, savedAt };
  try {
    try {
      window.localStorage.setItem(key, JSON.stringify(saved));
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      saved = { table: dropAttachments(table), savedAt, attachmentsDropped: true };
      window.localStorage.setItem(key, JSON.stringify(saved));
    }
  } catch (err) {
    raiseWarning(
      table,
      isQuotaError(err)
        ? `Browser storage is full, so “${table.title}” is not being saved. Delete older tables from the list on the left to make room.`
        : `“${table.title}” could not be saved in the browser. It will be lost when you close the page.`,
    );
    return null;
  }
  if (saved.attachmentsDropped) {
    raiseWarning(
      table,
      `Browser storage is almost full, so “${table.title}” is saved without its images. Delete older tables from the list on the left to keep images.`,
    );
  } else {
    clearWarningFor(table.id);
  }

  const summary: TableSummary = { id: table.id, title: table.title, createdAt: table.createdAt, updatedAt: savedAt };
  updateIndex((list) => [summary, ...list.filter((s) => s.id !== table.id)]);
  return savedAt;
}

export function readTable(id: string): { table: Table; savedAt: number } | null {
  try {
    const raw = window.localStorage.getItem(TABLE_PREFIX + id);
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedTable;
    if (!saved?.table?.id) return null;
    return { table: normalizeTable(saved.table), savedAt: saved.savedAt ?? 0 };
  } catch {
    return null;
  }
}

export function removeTable(id: string) {
  try {
    window.localStorage.removeItem(TABLE_PREFIX + id);
  } catch {
    // Nothing to do. The index entry is removed below either way.
  }
  updateIndex((list) => list.filter((s) => s.id !== id));
  if (warning?.tableId === id) {
    clearWarningFor(id);
  } else if (warning) {
    // Deleting a table frees space, so try the table that could not be saved again.
    writeTable(warning.table);
  }
}

// ---------- older or partial saved copies ----------

// The store marks anything that was still running as stopped when it opens
// a table. This only fills in fields an older saved copy may lack.
function normalizeTable(table: Table): Table {
  return { ...table, arbiters: table.arbiters ?? [], rounds: table.rounds ?? [], privateThreads: table.privateThreads ?? {} };
}

// ---------- throttled saving ----------

const pending = new Set<() => void>();
let pagehideBound = false;

function bindPagehide() {
  if (pagehideBound || typeof window === "undefined") return;
  pagehideBound = true;
  window.addEventListener("pagehide", () => {
    pending.forEach((flush) => flush());
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
