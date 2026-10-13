// Keeps the live table stores for this page and saves them to the server as
// they change. A table keeps running and saving when you switch to another one.
//
// A new table is a draft until its first message is sent. Drafts are not
// saved, so pressing New conversation and leaving does not fill the recent list.
//
// Another tab or browser may have the same table open. Every 5 seconds the
// list from the server says which tables changed elsewhere. A table that is
// idle here, with nothing unsaved, is reloaded. A table that is busy here is
// marked stale: the work goes on, each save merges the saved copy in, and the
// merged copy is loaded once the work ends, so neither side's rounds are lost.
// A save that the server refuses as older (409) is merged and sent again.

import type { ModelsResponse, PrivateMessage, Table, TableStore } from "@/lib/types";
import { applyEdit, createTableStore, newTable, speak } from "./engine";
import { applyPreset, builtinPresets, listPresets } from "./presets";
import { readDefaultPreset } from "./settings";
import {
  createSaver,
  describeFailure,
  onRefresh,
  readTable,
  removeTable,
  renameInIndex,
  setWarning,
  startSync,
  writeTable,
  type IndexSnapshot,
  type Saver,
} from "./storage";
import { isBusy, UNTITLED } from "./view";

interface Entry {
  store: TableStore;
  saver: Saver;
  unsubscribe: () => void;
  synced: Table | null; // the store's table as last saved or loaded; null until then
  serverAt: number; // updatedAt of the server's copy as last seen here; 0 when it has none
  knownAt: number; // when serverAt was set, by this page's clock
  stale: boolean; // the server's copy has changes this store lacks
  saving: Promise<void> | null;
  saveAgain: boolean; // the table changed while a save was in flight
  failed: boolean; // the last save failed, so the next poll tries again
  reloading: boolean;
}

// A table the page is fetching, could not find, or could not fetch.
export type TableLoad = { state: "loading" } | { state: "missing" } | { state: "failed"; message: string };

const entries = new Map<string, Entry>();
const loads = new Map<string, TableLoad>();
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
  startSync();
  // When the page is closing, stop live tables first. Their requests then end
  // as "Stopped" instead of failing as network errors, and the saved copy says so.
  window.addEventListener("beforeunload", () => {
    entries.forEach((e) => {
      if (isBusy(e.store.getTable())) e.store.stop();
    });
  });
}

// ---------- tracking ----------

function track(store: TableStore, serverAt = 0): TableStore {
  bindWindow();
  const id = store.getTable().id;
  const entry: Entry = {
    store,
    saver: createSaver(() => save(entry)),
    unsubscribe: () => {},
    synced: serverAt ? store.getTable() : null,
    serverAt,
    knownAt: Date.now(),
    stale: false,
    saving: null,
    saveAgain: false,
    failed: false,
    reloading: false,
  };
  let last = store.getTable();
  entry.unsubscribe = store.subscribe(() => {
    const table = store.getTable();
    // Save at once when a round starts or ends, so a reload shows the right state.
    const changed = isBusy(table) !== isBusy(last) || table.rounds.length !== last.rounds.length;
    last = table;
    if (changed) entry.saver.flush();
    else entry.saver.schedule();
  });
  entries.set(id, entry);
  return store;
}

function hasUnsaved(entry: Entry): boolean {
  return entry.store.getTable() !== entry.synced;
}

// Sends the whole table. Only one save per table is in flight; a change made
// meanwhile is saved when it ends.
function save(entry: Entry) {
  if (entry.saving) {
    entry.saveAgain = true;
    return;
  }
  const table = entry.store.getTable();
  const id = table.id;
  if (deleted.has(id) || table.rounds.length === 0 || !hasUnsaved(entry)) return;
  entry.saving = (async () => {
    let sent = table;
    if (entry.stale) {
      try {
        const saved = await readTable(id);
        if (!saved) {
          // Deleted elsewhere. Writing it now would bring it back.
          deletedElsewhere(id);
          return;
        }
        sent = merged(table, saved);
      } catch {
        // The write below fails the same way and raises the warning.
      }
    }
    let result = await writeTable(sent);
    if (result.status === "conflict") {
      sent = merged(table, result.saved);
      result = await writeTable(sent, { force: true });
    }
    if (result.status !== "saved") {
      entry.failed = true;
      return;
    }
    entry.failed = false;
    entry.serverAt = result.summary.updatedAt;
    entry.knownAt = Date.now();
    entry.synced = table;
    if (sent === table || entries.get(id) !== entry) return;
    // The saved copy holds changes from elsewhere. Load it now if nothing is
    // running here; otherwise keep merging until the work ends.
    if (!isBusy(entry.store.getTable()) && entry.store.getTable() === table) replace(id, sent);
    else entry.stale = true;
  })().finally(() => {
    entry.saving = null;
    if (entry.saveAgain && entries.get(id) === entry) {
      entry.saveAgain = false;
      save(entry);
    }
  });
}

function merged(ours: Table, saved: Table): Table {
  return { ...mergeTables(ours, saved), updatedAt: Math.max(Date.now(), ours.updatedAt, saved.updatedAt + 1) };
}

function drop(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  entry.saver.cancel();
  entry.unsubscribe();
  entries.delete(id);
}

// Swaps in a new store for a table that changed on the server.
function replace(id: string, table: Table) {
  drop(id);
  track(createTableStore(table, speak), table.updatedAt);
  bump();
}

// ---------- changes from elsewhere ----------

onRefresh((snapshot) => {
  for (const [id, load] of loads) {
    const listed = snapshot?.tables.some((s) => s.id === id);
    if (load.state === "failed" || (load.state === "missing" && listed)) fetchTable(id);
  }
  for (const entry of entries.values()) {
    if (entry.failed && !entry.saving) save(entry);
  }
  if (snapshot) checkForChanges(snapshot);
});

function checkForChanges(snapshot: IndexSnapshot) {
  const byId = new Map(snapshot.tables.map((s) => [s.id, s]));
  for (const [id, entry] of [...entries]) {
    if (entry.serverAt === 0) continue; // the server has no copy yet
    const summary = byId.get(id);
    if (!summary) {
      // Deleted elsewhere, unless this page saved it after the list was read.
      if (entry.knownAt < snapshot.startedAt && !entry.saving) deletedElsewhere(id);
      continue;
    }
    if (summary.updatedAt <= entry.serverAt) continue;
    if (isBusy(entry.store.getTable()) || entry.saving || hasUnsaved(entry)) entry.stale = true;
    else void reload(id, entry);
  }
}

async function reload(id: string, entry: Entry) {
  if (entry.reloading) return;
  entry.reloading = true;
  try {
    const table = await readTable(id);
    if (!table || entries.get(id) !== entry) return; // a deletion shows in the list
    if (isBusy(entry.store.getTable()) || entry.saving || hasUnsaved(entry)) entry.stale = true;
    else replace(id, table);
  } catch {
    // The next poll tries again.
  } finally {
    entry.reloading = false;
  }
}

function deletedElsewhere(id: string) {
  deleted.add(id);
  const entry = entries.get(id);
  if (entry && isBusy(entry.store.getTable())) entry.store.stop();
  drop(id);
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
  for (const id of [...stored.seats.map((s) => s.id), ...stored.arbiters.map((a) => a.id)]) {
    const byId = new Map<string, PrivateMessage>();
    for (const m of stored.privateThreads[id] ?? []) byId.set(m.id, m);
    for (const m of ours.privateThreads[id] ?? []) byId.set(m.id, m);
    if (byId.size) privateThreads[id] = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
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

// The live store for a saved table, or null while it is being fetched or
// when it cannot be opened. tableLoad says which.
export function openTable(id: string): TableStore | null {
  const known = entries.get(id);
  if (known) return known.store;
  if (deleted.has(id)) return null;
  if (!loads.has(id)) fetchTable(id);
  return null;
}

export function tableLoad(id: string): TableLoad | null {
  return loads.get(id) ?? null;
}

function fetchTable(id: string) {
  bindWindow();
  loads.set(id, { state: "loading" });
  readTable(id).then(
    (table) => {
      if (entries.has(id) || deleted.has(id)) {
        loads.delete(id);
      } else if (!table) {
        loads.set(id, { state: "missing" });
      } else {
        loads.delete(id);
        track(createTableStore(table, speak), table.updatedAt);
      }
      bump();
    },
    (err: unknown) => {
      loads.set(id, { state: "failed", message: describeFailure("Could not load the conversation.", err) });
      bump();
    },
  );
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

// Called once the draft's first round has started. The next New conversation makes a fresh draft.
export function releaseDraft(store: TableStore) {
  if (store !== draft) return;
  draft = null;
  draftAsMade = null;
}

// Removes the table here at once. If the server refuses, it comes back.
export function deleteTable(id: string) {
  deleted.add(id);
  const entry = entries.get(id);
  const inFlight = entry?.saving ?? null;
  if (entry && isBusy(entry.store.getTable())) entry.store.stop();
  drop(id);
  loads.delete(id);
  void removeTable(id, inFlight).then((ok) => {
    if (ok) return;
    deleted.delete(id);
    bump();
  });
}

// Renames a saved table. A table that is live on this page is renamed through
// its store, which refuses while it is replying, so the row keeps its old
// title. Any other table is fetched, renamed and saved.
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
  renameInIndex(id, name);
  void (async () => {
    try {
      const saved = await readTable(id);
      if (!saved || saved.title === name || deleted.has(id)) return;
      await writeTable({ ...saved, title: name, updatedAt: Date.now() });
    } catch (err) {
      setWarning(`table:${id}`, describeFailure("Could not rename the conversation.", err));
    }
  })();
}
