"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ModelsResponse, TableStore } from "@/lib/types";
import { FIXTURE_MODELS, isFixtureName, previewTable } from "@/lib/ui/fixtures";
import { indexStore, storageWarningStore } from "@/lib/ui/storage";
import {
  deleteTable,
  getDraft,
  isDraft,
  openTable,
  releaseDraft,
  renameTable,
  storesVersion,
  subscribeStores,
  tableLoad,
} from "@/lib/ui/tables";
import { type Drawer, FOCUSABLE, useCompact } from "@/lib/ui/useCompact";
import { useTable } from "@/lib/ui/useStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./Sidebar";
import { TableScreen } from "./TableScreen";
import { Banner, cx, IconButton } from "./ui";

// ---------- a small hash router ----------
// A new table is "/". A saved table opens at "/#/table/<id>", so a reload
// returns to it. Development previews of the fixtures open at "/#/preview/<name>".

type Route = { view: "new" } | { view: "table"; id: string } | { view: "preview"; name: string };

const routeListeners = new Set<() => void>();

function subscribeRoute(listener: () => void) {
  routeListeners.add(listener);
  window.addEventListener("hashchange", listener);
  window.addEventListener("popstate", listener);
  return () => {
    routeListeners.delete(listener);
    window.removeEventListener("hashchange", listener);
    window.removeEventListener("popstate", listener);
  };
}

function navigate(hash: string, replace = false) {
  const url = hash ? `#${hash}` : window.location.pathname + window.location.search;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  routeListeners.forEach((l) => l());
}

function parseRoute(hash: string): Route {
  const [, kind, id] = hash.replace(/^#/, "").split("/");
  if (kind === "table" && id) return { view: "table", id };
  if (kind === "preview" && process.env.NODE_ENV !== "production") return { view: "preview", name: id ?? "" };
  return { view: "new" };
}

// ---------- models ----------

interface ModelsState {
  data: ModelsResponse | null;
  error: string | null;
  retry: () => void;
}

function useModels(): ModelsState {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `The server answered with status ${res.status}.`);
        }
        return (await res.json()) as ModelsResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const detail = err instanceof Error && err.message ? err.message : "The request failed.";
        setError(`The model list could not be loaded. ${detail}`);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((a) => a + 1);
  }, []);

  return { data, error, retry };
}

// ---------- app ----------

export default function App() {
  const hash = useSyncExternalStore(subscribeRoute, () => window.location.hash, () => null);
  const route = useMemo(() => (hash === null ? null : parseRoute(hash)), [hash]);
  const models = useModels();
  const recent = useSyncExternalStore(indexStore.subscribe, indexStore.get, indexStore.server);
  const storageWarning = useSyncExternalStore(storageWarningStore.subscribe, storageWarningStore.get, storageWarningStore.server);
  // Re-renders when a table loads from the server, or is reloaded because it changed elsewhere.
  useSyncExternalStore(subscribeStores, storesVersion, () => 0);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const compact = useCompact();
  // The drawer open in the compact layout. Only one is open at a time.
  const [drawer, setDrawer] = useState<Drawer>(null);

  // Moving to another conversation, or leaving the compact layout, closes the
  // drawer. This is done during render so the old drawer never shows.
  const [drawerFor, setDrawerFor] = useState({ hash, compact });
  if (drawerFor.hash !== hash || drawerFor.compact !== compact) {
    setDrawerFor({ hash, compact });
    setDrawer(null);
  }

  // Escape closes the drawer. Menus, dialogs and text fields that use Escape
  // themselves call preventDefault, so those presses are left alone.
  useEffect(() => {
    if (!drawer) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) setDrawer(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawer]);

  // When the sidebar drawer opens, focus moves into it. When it closes, focus
  // goes back to the header button that opens it, if that button is still there.
  const lastDrawer = useRef<Drawer>(null);
  useEffect(() => {
    const was = lastDrawer.current;
    lastDrawer.current = drawer;
    if (drawer === "side" && was !== "side") {
      document.querySelector<HTMLElement>(`.sidebar :is(${FOCUSABLE})`)?.focus();
    } else if (was === "side" && drawer !== "side") {
      document.querySelector<HTMLElement>('.head .ibtn[aria-label="Show the sidebar"]')?.focus();
    }
  }, [drawer]);

  const preview = route?.view === "preview";
  const data = preview ? FIXTURE_MODELS : models.data;

  // Looking up a store is cheap and gives the same store each time, so it is
  // done on every render. That also picks up a store that was just fetched or
  // replaced.
  let store: TableStore | null = null;
  if (route?.view === "preview") store = isFixtureName(route.name) ? previewTable(route.name) : null;
  else if (route?.view === "table") store = openTable(route.id);
  else if (route && models.data) store = getDraft(models.data);

  const newTable = useCallback(() => navigate(""), []);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const showSidebar = compact ? () => setDrawer("side") : () => setSidebarHidden(false);

  const onStarted = useCallback((s: TableStore) => {
    if (window.location.hash.startsWith("#/preview")) return;
    releaseDraft(s);
    const id = s.getTable().id;
    if (window.location.hash !== `#/table/${id}`) navigate(`/table/${id}`, true);
  }, []);

  const onDelete = useCallback(
    (id: string) => {
      deleteTable(id);
      if (route?.view === "table" && route.id === id) navigate("", true);
    },
    [route],
  );

  if (!route) {
    return (
      <div className="app">
        <title>Consortium</title>
      </div>
    );
  }

  const banners = (
    <>
      {storageWarning ? <Banner>{storageWarning}</Banner> : null}
      {models.error && !preview ? (
        <Banner
          action={
            <button type="button" className="btn sm" onClick={models.retry}>
              Try again
            </button>
          }
        >
          {models.error} Check that the app is running, then try again.
        </Banner>
      ) : null}
    </>
  );

  let screen: React.ReactNode;
  if (store) {
    screen = (
      <TableScreen
        key={store.getTable().id}
        store={store}
        data={data}
        participantsOpen={participantsOpen}
        setParticipantsOpen={setParticipantsOpen}
        sidebarHidden={sidebarHidden}
        onShowSidebar={showSidebar}
        compact={compact}
        drawer={drawer}
        setDrawer={setDrawer}
        onNew={newTable}
        onStarted={onStarted}
        banners={banners}
      />
    );
  } else {
    let title = "Loading";
    let body: React.ReactNode = <p>Loading the model list.</p>;
    if (route.view === "table") {
      const load = tableLoad(route.id);
      if (load?.state === "loading") {
        body = <p>Loading the conversation.</p>;
      } else {
        title = load?.state === "failed" ? "This conversation could not be loaded" : "This conversation could not be found";
        body = (
          <>
            <p>{load?.state === "failed" ? load.message : "It may have been deleted."}</p>
            <button type="button" className="btn primary" onClick={newTable}>
              New conversation
            </button>
          </>
        );
      }
    } else if (route.view === "preview") {
      title = "No preview with that name";
      body = <p>Try /#/preview/new, group, independent, running or demo.</p>;
    } else if (models.error) {
      title = "The conversation could not be set up";
      body = <p>A new conversation needs the model list to choose its agents.</p>;
    }
    screen = (
      <main className="main">
        <title>Consortium</title>
        <header className="head">
          {compact || sidebarHidden ? <IconButton icon="sidebar" label="Show the sidebar" onClick={showSidebar} /> : null}
        </header>
        {banners}
        <div className="center">
          <h2>{title}</h2>
          {body}
        </div>
      </main>
    );
  }

  return (
    <div className={cx("app", sidebarHidden && "no-side")}>
      {compact && drawer ? <div className="scrim" aria-hidden="true" onClick={closeDrawer} /> : null}
      {(compact ? drawer === "side" : !sidebarHidden) ? (
        <SidebarFor
          store={store}
          preview={preview}
          recent={recent}
          mock={Boolean(data?.mock)}
          onNew={
            compact
              ? () => {
                  setDrawer(null);
                  newTable();
                }
              : newTable
          }
          onRename={renameTable}
          onDelete={onDelete}
          onHide={compact ? closeDrawer : () => setSidebarHidden(true)}
          onPick={compact ? closeDrawer : undefined}
          onSettings={() => setSettingsOpen(true)}
        />
      ) : null}
      {screen}
      {settingsOpen ? <SettingsModal data={data} onClose={() => setSettingsOpen(false)} /> : null}
      <ConfirmDialog />
    </div>
  );
}

// The sidebar reads the open table so a draft or preview shows as the current row.
function SidebarFor({
  store,
  preview,
  ...rest
}: {
  store: TableStore | null;
  preview: boolean;
  recent: React.ComponentProps<typeof Sidebar>["recent"];
  mock: boolean;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onHide: () => void;
  onPick?: () => void;
  onSettings: () => void;
}) {
  if (!store) return <Sidebar currentId={null} currentTitle="" showCurrent={false} {...rest} />;
  return <SidebarWithTable store={store} preview={preview} {...rest} />;
}

function SidebarWithTable({
  store,
  preview,
  recent,
  ...rest
}: {
  store: TableStore;
  preview: boolean;
  recent: React.ComponentProps<typeof Sidebar>["recent"];
  mock: boolean;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onHide: () => void;
  onPick?: () => void;
  onSettings: () => void;
}) {
  const table = useTable(store);
  const saved = recent.some((t) => t.id === table.id);
  const showCurrent = preview || isDraft(store) || !saved;
  return (
    <Sidebar
      recent={recent.filter((t) => t.id !== table.id || !showCurrent)}
      currentId={table.id}
      currentTitle={table.title}
      showCurrent={showCurrent}
      {...rest}
    />
  );
}
