"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ModelsResponse, TableStore } from "@/lib/types";
import { FIXTURE_MODELS, isFixtureName, previewTable } from "@/lib/ui/fixtures";
import { indexStore, storageWarningStore } from "@/lib/ui/storage";
import { deleteTable, getDraft, isDraft, openTable, releaseDraft, renameTable, storesVersion, subscribeStores } from "@/lib/ui/tables";
import { useTable } from "@/lib/ui/useStore";
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
  // Re-renders when a table is reloaded because another tab saved it.
  useSyncExternalStore(subscribeStores, storesVersion, () => 0);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(true);

  const preview = route?.view === "preview";
  const data = preview ? FIXTURE_MODELS : models.data;

  // Looking up a store is cheap and gives the same store each time, so it is
  // done on every render. That also picks up a store another tab replaced.
  let store: TableStore | null = null;
  if (route?.view === "preview") store = isFixtureName(route.name) ? previewTable(route.name) : null;
  else if (route?.view === "table") store = openTable(route.id);
  else if (route && models.data) store = getDraft(models.data);

  const newTable = useCallback(() => navigate(""), []);

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
        onShowSidebar={() => setSidebarHidden(false)}
        onNew={newTable}
        onStarted={onStarted}
        banners={banners}
      />
    );
  } else {
    let title = "Loading";
    let body: React.ReactNode = <p>Loading the model list.</p>;
    if (route.view === "table") {
      title = "This table could not be found";
      body = (
        <>
          <p>It may have been deleted, or it was saved in a different browser. Tables are saved only in the browser where they ran.</p>
          <button type="button" className="btn primary" onClick={newTable}>
            New table
          </button>
        </>
      );
    } else if (route.view === "preview") {
      title = "No preview with that name";
      body = <p>Try /#/preview/new, group, independent or running.</p>;
    } else if (models.error) {
      title = "The table could not be set up";
      body = <p>A new table needs the model list to choose its agents.</p>;
    }
    screen = (
      <main className="main">
        <title>Consortium</title>
        <header className="head">
          {sidebarHidden ? <IconButton icon="sidebar" label="Show the sidebar" onClick={() => setSidebarHidden(false)} /> : null}
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
      {sidebarHidden ? null : (
        <SidebarFor
          store={store}
          preview={preview}
          recent={recent}
          mock={Boolean(data?.mock)}
          onNew={newTable}
          onRename={renameTable}
          onDelete={onDelete}
          onHide={() => setSidebarHidden(true)}
        />
      )}
      {screen}
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
