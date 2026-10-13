"use client";

import { confirm } from "@/lib/ui/confirm";

import { useEffect, useRef, useState } from "react";
import { shortTime } from "@/lib/ui/format";
import type { TableSummary } from "@/lib/ui/storage";
import { useNow } from "@/lib/ui/useNow";
import { UNTITLED } from "@/lib/ui/view";
import { Icon, Mark } from "./Icon";
import { cx, IconButton, Menu, type Resize, ResizeHandle } from "./ui";

export function Sidebar({
  recent,
  currentId,
  currentTitle,
  showCurrent,
  mock,
  onNew,
  onRename,
  onDelete,
  onHide,
  onPick,
  onSettings,
  resize,
}: {
  recent: TableSummary[];
  currentId: string | null;
  currentTitle: string;
  showCurrent: boolean; // the open conversation is a draft or preview that is not in the saved list
  mock: boolean;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onHide: () => void;
  onPick?: () => void; // a conversation row was chosen, including the one already open
  onSettings: () => void;
  resize?: Resize; // present while the sidebar sits beside the conversation
}) {
  const now = useNow();
  const navRef = useRef<HTMLElement>(null);
  // Only one row has its menu open at a time.
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLButtonElement } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // After a rename ends from the keyboard, focus goes back to that row's link.
  const focusLink = useRef<string | null>(null);

  useEffect(() => {
    const id = focusLink.current;
    if (!id || renaming) return;
    focusLink.current = null;
    navRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"] .row-link`)?.focus();
  });

  function closeMenu(refocus: boolean) {
    if (refocus) menu?.anchor.focus();
    setMenu(null);
  }

  function finishRename(id: string, title: string, next: string | null, fromKeyboard: boolean) {
    if (next !== null) {
      const name = next.trim() || UNTITLED;
      if (name !== title) onRename(id, name);
    }
    if (fromKeyboard) focusLink.current = id;
    setRenaming(null);
  }

  return (
    <aside className="sidebar">
      <div className="side-top">
        <span className="brand">
          <Mark />
          Consortium
        </span>
        <IconButton icon="sidebar" label="Hide the sidebar" onClick={onHide} />
      </div>

      <button type="button" className="btn new-btn" onClick={onNew}>
        <Icon name="plus" />
        New conversation
      </button>

      <nav className="recent" aria-label="Recent conversations" ref={navRef}>
        <h2 className="side-h">Recent</h2>
        <ul>
          {showCurrent ? (
            <li className="row on">
              <span className="row-link" aria-current="page">
                <span className="row-title">{currentTitle || UNTITLED}</span>
              </span>
            </li>
          ) : null}
          {recent.map((t) => {
            const on = t.id === currentId;
            const title = (on ? currentTitle : t.title) || UNTITLED;
            const menuOpen = menu?.id === t.id;
            if (renaming === t.id) {
              return (
                <li key={t.id} className={cx("row renaming", on && "on")} data-row={t.id}>
                  <div className="row-link">
                    <RowRename
                      title={title}
                      onDone={(next, fromKeyboard) => finishRename(t.id, title, next, fromKeyboard)}
                    />
                  </div>
                </li>
              );
            }
            return (
              <li key={t.id} className={cx("row", on && "on", menuOpen && "menu-open")} data-row={t.id}>
                <a className="row-link" href={`#/table/${t.id}`} aria-current={on ? "page" : undefined} onClick={onPick}>
                  <span className="row-title">{title}</span>
                  {on ? null : <span className="row-time">{shortTime(t.updatedAt, now)}</span>}
                </a>
                <MoreButton
                  title={title}
                  open={menuOpen}
                  onOpen={(anchor) => setMenu({ id: t.id, anchor })}
                  onClose={() => closeMenu(false)}
                />
                {menuOpen ? (
                  <Menu anchor={menu.anchor} label={`More for ${title}`} onClose={closeMenu}>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      onClick={() => {
                        setMenu(null);
                        setRenaming(t.id);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      onClick={async () => {
                        closeMenu(true);
                        if (await confirm({ message: `Delete “${title}”? This removes it from this computer.`, action: "Delete" })) {
                          onDelete(t.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </Menu>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>

      <button type="button" className="side-btn" onClick={onSettings}>
        <Icon name="settings" />
        Settings
      </button>

      {mock ? (
        <p className="side-foot">
          <b>Sample mode</b>
          <br />
          The app writes the replies itself.
        </p>
      ) : null}
      {resize ? <ResizeHandle edge="end" label="Resize the sidebar" resize={resize} /> : null}
    </aside>
  );
}

function MoreButton({
  title,
  open,
  onOpen,
  onClose,
}: {
  title: string;
  open: boolean;
  onOpen: (anchor: HTMLButtonElement) => void;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      className="row-more"
      aria-label={`More for ${title}`}
      title="More"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(e) => (open ? onClose() : onOpen(e.currentTarget))}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" && !open) {
          e.preventDefault();
          onOpen(e.currentTarget);
        }
      }}
    >
      <Icon name="more" size={14} />
    </button>
  );
}

// The row's title as a text field. Enter or leaving the field saves, Escape cancels.
function RowRename({ title, onDone }: { title: string; onDone: (next: string | null, fromKeyboard: boolean) => void }) {
  const [value, setValue] = useState(title);
  const done = useRef(false);

  function finish(next: string | null, fromKeyboard: boolean) {
    if (done.current) return;
    done.current = true;
    onDone(next, fromKeyboard);
  }

  return (
    <input
      className="row-input"
      value={value}
      aria-label="Conversation title"
      maxLength={120}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value, false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(value, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null, true);
        }
      }}
    />
  );
}
