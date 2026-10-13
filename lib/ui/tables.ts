// Keeps the live table stores for this page and saves them as they change.
// A table keeps running and saving when you switch to another one.
//
// A new table is a draft until its first message is sent. Drafts are not
// saved, so pressing New table and leaving does not fill the recent list.
//
// Another tab may have the same table open. When it saves the table, this
// tab reloads its copy if the table is idle here. If a round or private reply
// is running here, the work goes on, and the next save merges the stored copy
// in, so neither tab's rounds are lost.

import type { ModelsResponse, PrivateMessage, SeatId, Table, TableStore } from "@/lib/types";
import { applyEdit, createTableStore, newTable, speak } from "./engine";
import { applyPreset, builtinPresets, listPresets } from "./presets";
import { readDefaultPreset } from "./settings";
import { createSaver, INDEX_KEY, readTable, reloadIndex, removeTable, tableIdFromKey, writeTable, type Saver } from "./storage";
import { isBusy, UNTITLED } from "./view";

interface Entry {
  store: TableStore;
  saver: Saver;
  unsubscribe: () => void;
  stale: boolean; // another tab saved this table while it was busy here
}

const entries = new Map<string, Entry>();
const deleted = new Set<string>();
let draft: TableStore | null = null;
let draftAsMade: Table | null = null; // the draft's table before any edit

// ---------- a version number, so the app re-reads a store that was replaced ----------

let version = 0;
const versionListeners = new Set<() => void>();

export function subscribeStores(listener: () => void) {
  versionListeners.add(listener);
  return () => {
    versionListeners.delete(listener);
  };
}

export function storesVersion(): number {
  return version;
}

function bump() {
  version += 1;
  versionListeners.forEach((l) => l());
}

// ---------- page events ----------

let bound = false;
function bindWindow() {
  if (bound || typeof window === "undefined") return;
  bound = true;
  // When the page is closing, stop live tables first. Their requests then end
  // as "Stopped" instead of failing as network errors, and the saved copy says so.
  window.addEventListener("beforeunload", () => {
    entries.forEach((e) => {
      if (isBusy(e.store.getTable())) e.store.stop();
    });
  });
  window.addEventListener("storage", (e) => {
    if (e.storageArea !== window.localStorage) return;
    if (e.key === null || e.key === INDEX_KEY) reloadIndex();
    const id = e.key ? tableIdFromKey(e.key) : null;
    if (id) storedTableChanged(id);
  });
}

function storedTableChanged(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  const stored = readTable(id);
  if (!stored) {
    // Deleted in another tab.
    deleted.add(id);
    if (isBusy(entry.store.getTable())) entry.store.stop();
    drop(id);
    bump();
    return;
  }
  if (isBusy(entry.store.getTable())) {
    entry.stale = true;
    return;
  }
  replace(id, stored.table);
}

// ---------- tracking ----------

function track(store: TableStore): TableStore {
  bindWindow();
  const id = store.getTable().id;
  const entry: Entry = {
    store,
    saver: createSaver(() => save(entry)),
    unsubscribe: () => {},
    stale: false,
  };
  let last = store.getTable();
  entry.unsubscribe = store.subscribe(() => {
    const table = store.getTable();
    const wasBusy = isBusy(last);
    const busy = isBusy(table);
    // Save at once when a round starts or ends, so a reload shows the right state.
    const changed = busy !== wasBusy || table.rounds.length !== last.rounds.length;
    last = table;
    if (!changed) {
      entry.saver.schedule();
      return;
    }
    const merge = entry.stale && !busy;
    entry.saver.flush();
    // Work finished while another tab had saved this table. The merged copy is
    // now stored, so load it, which brings in the other tab's changes.
    if (merge) {
      const stored = readTable(id);
      if (stored) replace(id, stored.table);
    }
  });
  entries.set(id, entry);
  return store;
}

// While a table is stale, every save merges the stored copy in. It stays
// stale until the work ends and the store is reloaded from the merged copy,
// because until then this tab's own copy still has the older settings.
function save(entry: Entry) {
  const table = entry.store.getTable();
  if (deleted.has(table.id) || table.rounds.length === 0) return;
  let toWrite = table;
  if (entry.stale) {
    const stored = readTable(table.id);
    if (stored) toWrite = mergeTables(table, stored.table);
  }
  writeTable(toWrite);
}

function drop(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  entry.saver.cancel();
  entry.unsubscribe();
  entries.delete(id);
}

// Swaps in a new store for a table that changed in storage.
function replace(id: string, table: Table) {
  drop(id);
  track(createTableStore(table, speak));
  bump();
}

// ---------- merging two copies of one table ----------

// Rounds this tab has win over the stored copy, since this tab ran them.
// Settings come from the stored copy, because they cannot change here while
// a table is busy. Private messages are combined by id.
export function mergeTables(ours: Table, stored: Table): Table {
  const rounds = new Map(stored.rounds.map((r) => [r.number, r]));
  for (const r of ours.rounds) rounds.set(r.number, r);

  const privateThreads: Table["privateThreads"] = {};
  for (const seat of stored.seats) {
    const byId = new Map<string, PrivateMessage>();
    for (const m of stored.privateThreads[seat.id] ?? []) byId.set(m.id, m);
    for (const m of ours.privateThreads[seat.id] ?? []) byId.set(m.id, m);
    if (byId.size) privateThreads[seat.id as SeatId] = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  return {
    ...ours,
    title: stored.title,
    interaction: stored.interaction,
    seats: stored.seats,
    arbiters: stored.arbiters,
    rounds: [...rounds.values()].sort((a, b) => a.number - b.number),
    privateThreads,
  };
}

// ---------- the API the app uses ----------

export function openTable(id: string): TableStore | null {
  const known = entries.get(id);
  if (known) return known.store;
  if (deleted.has(id)) return null;
  const stored = readTable(id);
  if (!stored) return null;
  return track(createTableStore(stored.table, speak));
}

// The current draft, or a new one when there is none.
export function getDraft(data: ModelsResponse): TableStore {
  if (draft && draft.getTable().rounds.length === 0) return draft;
  draft = track(createTableStore(newDraftTable(data), speak));
  draftAsMade = draft.getTable();
  return draft;
}

// A new table with the default setup chosen in Settings. A preset that no
// longer exists, or is not available with this model list, is ignored.
function newDraftTable(data: ModelsResponse): Table {
  const table = newTable(data, data.models);
  const id = readDefaultPreset();
  if (!id) return table;
  const preset = [...builtinPresets(data), ...listPresets()].find((p) => p.id === id);
  return preset ? applyEdit(table, applyPreset(preset)) : table;
}

// The default setup changed. A draft nobody has edited yet is dropped, so the
// next one is made with the new setup.
export function defaultSetupChanged() {
  if (!draft || draft.getTable() !== draftAsMade) return;
  drop(draft.getTable().id);
  draft = null;
  draftAsMade = null;
  bump();
}

export function isDraft(store: TableStore): boolean {
  return store === draft && store.getTable().rounds.length === 0;
}

// Called once the draft's first round has started. The next New table makes a fresh draft.
export function releaseDraft(store: TableStore) {
  if (store !== draft) return;
  draft = null;
  draftAsMade = null;
}

export function deleteTable(id: string) {
  deleted.add(id);
  const entry = entries.get(id);
  if (entry && isBusy(entry.store.getTable())) entry.store.stop();
  drop(id);
  removeTable(id);
}

// Renames a saved table. A table that is live on this page is renamed through
// its store, which refuses while it is replying, so the row keeps its old
// title. Any other table is renamed in storage, which updates the recent list.
export function renameTable(id: string, title: string) {
  if (deleted.has(id)) return;
  const name = title.trim() || UNTITLED;
  const entry = entries.get(id);
  if (entry) {
    const before = entry.store.getTable();
    entry.store.edit({ title: name });
    if (entry.store.getTable() !== before) entry.saver.flush();
    return;
  }
  const stored = readTable(id);
  if (!stored || stored.table.title === name) return;
  writeTable({ ...stored.table, title: name, updatedAt: Date.now() });
}
