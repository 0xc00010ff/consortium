"use client";

import { useEffect, useRef, useState } from "react";
import type { Attachment, ModelsResponse, Table, TableStore } from "@/lib/types";
import { downloadText, exportFilename } from "@/lib/ui/download";
import { confirm } from "@/lib/ui/confirm";
import { tableToMarkdown, threadPrivacy } from "@/lib/ui/engine";
import { type Drawer, FOCUSABLE } from "@/lib/ui/layout";
import { useStickToBottom } from "@/lib/ui/useStickToBottom";
import { useTable } from "@/lib/ui/useStore";
import { isBusy, latestReply, participantIn, privateBusyParticipant, subtitle, UNTITLED } from "@/lib/ui/view";
import { Composer } from "./Composer";
import { Icon } from "./Icon";
import { ParticipantsPanel } from "./ParticipantsPanel";
import { PrivatePanel } from "./PrivatePanel";
import { Thread } from "./Thread";
import { Banner, IconButton, type Resize } from "./ui";

export function TableScreen({
  store,
  data,
  participantsOpen,
  setParticipantsOpen,
  sidebarHidden,
  onShowSidebar,
  sideDrawer,
  panelDrawer,
  panelResize,
  drawer,
  setDrawer,
  onNew,
  onStarted,
  banners,
}: {
  store: TableStore;
  data: ModelsResponse | null;
  participantsOpen: boolean;
  setParticipantsOpen: (open: boolean) => void;
  sidebarHidden: boolean;
  onShowSidebar: () => void;
  sideDrawer: boolean; // the sidebar opens over the conversation
  panelDrawer: boolean; // the right panel opens over the conversation
  panelResize?: Resize; // present while the right panel sits beside the conversation
  drawer: Drawer;
  setDrawer: (drawer: Drawer) => void;
  onNew: () => void;
  onStarted: (store: TableStore) => void; // a round has started
  banners?: React.ReactNode;
}) {
  const table = useTable(store);
  const busy = isBusy(table);
  const privateBusy = privateBusyParticipant(table);
  // The agent or arbiter whose side conversation is open.
  const [openId, setOpenId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // A message handed back to the composer by a rewind. The number changes on
  // every rewind, so the composer starts again with that message.
  const [draft, setDraft] = useState<{ n: number; text: string; attachments: Attachment[] } | null>(null);
  const stick = useStickToBottom();

  // When the right panel is a drawer, a side conversation stays open only
  // while that drawer is open.
  const panelOpen = panelDrawer ? drawer === "panel" : participantsOpen;
  if (panelDrawer && !panelOpen && openId !== null) setOpenId(null);

  // When the panel drawer opens, focus moves into it. When it closes, focus
  // goes back to the participants button in the header.
  const lastDrawer = useRef<Drawer>(drawer);
  useEffect(() => {
    const was = lastDrawer.current;
    lastDrawer.current = drawer;
    if (drawer === "panel" && was !== "panel") {
      document.querySelector<HTMLElement>(`.panel :is(${FOCUSABLE})`)?.focus();
    } else if (was === "panel" && drawer !== "panel") {
      document.querySelector<HTMLElement>(".head-acts .ibtn")?.focus();
    }
  }, [drawer]);

  // An agent or arbiter removed from the table takes its side conversation with it.
  const open = openId ? participantIn(undefined, table, openId) : undefined;
  const first = table.rounds.length === 0;
  const allOff = table.seats.every((s) => s.active === false);

  // The store's own message says what went wrong and what to do.
  function report(err: unknown) {
    setRunError(err instanceof Error && err.message ? err.message : "The conversation could not start replying. Try again.");
  }

  // Returns false when the store refused the round, for example while it is
  // busy. The round's first change is published at once when it starts.
  function sendRound(text: string, attachments: Attachment[]): boolean {
    setRunError(null);
    const before = store.getTable().rounds.length;
    store.sendRound({ text, attachments }).catch(report);
    if (store.getTable().rounds.length === before) return false;
    onStarted(store);
    stick.jump();
    return true;
  }

  function sendPrivate(text: string): boolean {
    if (!open) return false;
    setRunError(null);
    const before = store.getTable().privateThreads[open.id]?.length ?? 0;
    store.sendPrivate(open.id, { text, attachments: [] }).catch(report);
    return (store.getTable().privateThreads[open.id]?.length ?? 0) > before;
  }

  // Deletes this round and the ones after it, after asking, and puts the
  // round's message back into the composer.
  async function rewind(roundNumber: number) {
    const last = table.rounds.length;
    const deleted =
      roundNumber === last ? `Round ${roundNumber} will be deleted` : `Rounds ${roundNumber} to ${last} will be deleted`;
    const message = table.rounds.find((r) => r.number === roundNumber)?.host;
    const what = roundNumber === 1 ? "your first message" : `your note for round ${roundNumber}`;
    const back = message && (message.text || message.attachments.length) ? `, and ${what} goes back into the composer.` : ".";
    const privateLost = Object.values(table.privateThreads).some((t) => t?.some((m) => m.afterRound >= roundNumber));
    const privateNote = privateLost ? ` Messages in side conversations sent after round ${roundNumber} will be deleted too.` : "";
    if (!(await confirm({ message: `Rewind to round ${roundNumber}? ${deleted}${back}${privateNote}`, action: "Rewind" }))) return;
    const host = store.rewind(roundNumber);
    if (!host) {
      setRunError(`The conversation could not go back to round ${roundNumber}. Wait until it finishes replying, then try again.`);
      return;
    }
    setRunError(null);
    setDraft((d) => ({ n: (d?.n ?? 0) + 1, text: host.text, attachments: host.attachments }));
  }

  function exportTable() {
    downloadText(exportFilename(table.title, table.createdAt), tableToMarkdown(table));
  }

  const participantsShown = !open && panelOpen;

  function openPrivate(id: string) {
    setOpenId(id);
    if (panelDrawer) setDrawer("panel");
  }

  function closePrivate() {
    setOpenId(null);
    if (panelDrawer) setDrawer(null);
  }

  function toggleParticipants() {
    if (open) {
      setOpenId(null);
      if (panelDrawer) setDrawer("panel");
      else setParticipantsOpen(true);
    } else if (panelDrawer) {
      setDrawer(drawer === "panel" ? null : "panel");
    } else {
      setParticipantsOpen(!participantsOpen);
    }
  }

  return (
    <>
      <title>{`${table.title || UNTITLED} · Consortium`}</title>
      <main className="main">
        <header className="head">
          {sideDrawer || sidebarHidden ? <IconButton icon="sidebar" label="Show the sidebar" onClick={onShowSidebar} /> : null}
          {!sideDrawer && sidebarHidden ? <IconButton icon="plus" label="New conversation" onClick={onNew} /> : null}
          <TitleBlock table={table} busy={busy} onRename={(title) => store.edit({ title })} />
          <div className="head-acts">
            <button
              type="button"
              className="btn ghost"
              onClick={exportTable}
              disabled={first}
              title={first ? "Available after the first round" : "Download as markdown"}
              aria-label="Export"
            >
              <Icon name="download" />
              <span className="btn-label">Export</span>
            </button>
            <IconButton
              icon="users"
              label={participantsShown ? "Hide participants" : "Show participants"}
              pressed={participantsShown}
              onClick={toggleParticipants}
            />
          </div>
        </header>
        {banners}
        {runError ? <Banner>{runError}</Banner> : null}
        <Thread
          table={table}
          openPrivateId={open?.id ?? null}
          highlightReplyId={open ? (latestReply(table, open.id)?.reply.id ?? null) : null}
          onOpenPrivate={openPrivate}
          onVote={(replyId, delta) => store.vote(replyId, delta)}
          onRewind={rewind}
          stick={stick}
        />
        <Composer
          key={`${table.id}:${draft?.n ?? 0}`}
          first={first}
          nextRound={table.rounds.length + 1}
          busy={busy}
          allOff={allOff}
          initial={draft ?? undefined}
          onSend={sendRound}
          onStop={() => store.stop()}
        />
      </main>
      {open ? (
        <PrivatePanel
          key={open.id}
          table={table}
          participant={open}
          busy={busy}
          replying={privateBusy === open.id}
          privacy={threadPrivacy(table, open.id)}
          onPrivacy={(p) => store.setThreadPrivacy(open.id, p)}
          onSend={sendPrivate}
          onStop={() => store.stop()}
          onClose={closePrivate}
          resize={panelResize}
        />
      ) : panelOpen ? (
        <ParticipantsPanel
          table={table}
          data={data}
          disabled={busy}
          onEdit={(edit) => store.edit(edit)}
          onClose={() => (panelDrawer ? setDrawer(null) : setParticipantsOpen(false))}
          resize={panelResize}
        />
      ) : null}
    </>
  );
}

function TitleBlock({ table, busy, onRename }: { table: Table; busy: boolean; onRename: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  function commit() {
    const next = value.trim();
    if (next && next !== table.title) onRename(next);
    setEditing(false);
  }

  return (
    <div className="head-title">
      {editing ? (
        <input
          className="title-input"
          value={value}
          aria-label="Conversation title"
          maxLength={120}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="title-btn"
          disabled={busy}
          title={busy ? "You can rename the conversation when it finishes replying." : "Rename the conversation"}
          onClick={() => {
            setValue(table.title);
            setEditing(true);
          }}
        >
          {table.title || UNTITLED}
        </button>
      )}
      <span className="head-sub">{subtitle(table)}</span>
    </div>
  );
}
