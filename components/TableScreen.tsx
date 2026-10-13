"use client";

import { useState } from "react";
import type { Attachment, ModelsResponse, SeatId, Table, TableStore } from "@/lib/types";
import { downloadText, exportFilename } from "@/lib/ui/download";
import { tableToMarkdown } from "@/lib/ui/engine";
import { useStickToBottom } from "@/lib/ui/useStickToBottom";
import { useTable } from "@/lib/ui/useStore";
import { isBusy, latestReply, privateBusySeat, subtitle, UNTITLED } from "@/lib/ui/view";
import { Composer } from "./Composer";
import { Icon } from "./Icon";
import { ParticipantsPanel } from "./ParticipantsPanel";
import { PrivatePanel } from "./PrivatePanel";
import { Thread } from "./Thread";
import { Banner, IconButton } from "./ui";

export function TableScreen({
  store,
  data,
  participantsOpen,
  setParticipantsOpen,
  sidebarHidden,
  onShowSidebar,
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
  onNew: () => void;
  onStarted: (store: TableStore) => void; // a round has started
  banners?: React.ReactNode;
}) {
  const table = useTable(store);
  const busy = isBusy(table);
  const privateSeat = privateBusySeat(table);
  const [openSeat, setOpenSeat] = useState<SeatId | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // A message handed back to the composer by a rewind. The number changes on
  // every rewind, so the composer starts again with that message.
  const [draft, setDraft] = useState<{ n: number; text: string; attachments: Attachment[] } | null>(null);
  const stick = useStickToBottom();

  // A seat removed from the table takes its private conversation with it.
  const seat = openSeat ? table.seats.find((s) => s.id === openSeat) : undefined;
  const first = table.rounds.length === 0;
  const allOff = table.seats.every((s) => s.active === false);

  // The store's own message says what went wrong and what to do.
  function report(err: unknown) {
    setRunError(err instanceof Error && err.message ? err.message : "The table could not start replying. Try again.");
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
    if (!seat) return false;
    setRunError(null);
    const before = store.getTable().privateThreads[seat.id]?.length ?? 0;
    store.sendPrivate(seat.id, { text, attachments: [] }).catch(report);
    return (store.getTable().privateThreads[seat.id]?.length ?? 0) > before;
  }

  // Deletes this round and the ones after it, after asking, and puts the
  // round's message back into the composer.
  function rewind(roundNumber: number) {
    const last = table.rounds.length;
    const deleted =
      roundNumber === last ? `Round ${roundNumber} will be deleted` : `Rounds ${roundNumber} to ${last} will be deleted`;
    const message = table.rounds.find((r) => r.number === roundNumber)?.host;
    const what = roundNumber === 1 ? "your first message" : `your note for round ${roundNumber}`;
    const back = message && (message.text || message.attachments.length) ? `, and ${what} goes back into the composer.` : ".";
    const privateLost = Object.values(table.privateThreads).some((t) => t?.some((m) => m.afterRound >= roundNumber));
    const privateNote = privateLost ? ` Private messages sent after round ${roundNumber} will be deleted too.` : "";
    if (!window.confirm(`Rewind to round ${roundNumber}? ${deleted}${back}${privateNote}`)) return;
    const host = store.rewind(roundNumber);
    if (!host) {
      setRunError(`The table could not go back to round ${roundNumber}. Wait until it finishes replying, then try again.`);
      return;
    }
    setRunError(null);
    setDraft((d) => ({ n: (d?.n ?? 0) + 1, text: host.text, attachments: host.attachments }));
  }

  function exportTable() {
    downloadText(exportFilename(table.title, table.createdAt), tableToMarkdown(table));
  }

  const participantsShown = !seat && participantsOpen;

  return (
    <>
      <title>{`${table.title || UNTITLED} · Consortium`}</title>
      <main className="main">
        <header className="head">
          {sidebarHidden ? (
            <>
              <IconButton icon="sidebar" label="Show the sidebar" onClick={onShowSidebar} />
              <IconButton icon="plus" label="New table" onClick={onNew} />
            </>
          ) : null}
          <TitleBlock table={table} busy={busy} onRename={(title) => store.edit({ title })} />
          <div className="head-acts">
            <button
              type="button"
              className="btn ghost"
              onClick={exportTable}
              disabled={first}
              title={first ? "Available after the first round" : "Download as markdown"}
            >
              <Icon name="download" />
              Export
            </button>
            <IconButton
              icon="users"
              label={participantsShown ? "Hide participants" : "Show participants"}
              pressed={participantsShown}
              onClick={() => {
                if (seat) {
                  setOpenSeat(null);
                  setParticipantsOpen(true);
                } else {
                  setParticipantsOpen(!participantsOpen);
                }
              }}
            />
          </div>
        </header>
        {banners}
        {runError ? <Banner>{runError}</Banner> : null}
        <Thread
          table={table}
          activeSeat={seat?.id ?? null}
          highlightReplyId={seat ? (latestReply(table, seat.id)?.reply.id ?? null) : null}
          onOpenPrivate={setOpenSeat}
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
      {seat ? (
        <PrivatePanel
          key={seat.id}
          table={table}
          seat={seat}
          busy={busy}
          replying={privateSeat === seat.id}
          onSend={sendPrivate}
          onStop={() => store.stop()}
          onClose={() => setOpenSeat(null)}
        />
      ) : participantsOpen ? (
        <ParticipantsPanel
          table={table}
          data={data}
          disabled={busy}
          onEdit={(edit) => store.edit(edit)}
          onClose={() => setParticipantsOpen(false)}
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
          aria-label="Table title"
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
          title={busy ? "You can rename the table when it finishes replying." : "Rename the table"}
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
