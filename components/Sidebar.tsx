"use client";

import { shortTime } from "@/lib/ui/format";
import type { TableSummary } from "@/lib/ui/storage";
import { useNow } from "@/lib/ui/useNow";
import { UNTITLED } from "@/lib/ui/view";
import { Icon, Mark } from "./Icon";
import { cx, IconButton } from "./ui";

export function Sidebar({
  recent,
  currentId,
  currentTitle,
  showCurrent,
  mock,
  onNew,
  onDelete,
  onHide,
}: {
  recent: TableSummary[];
  currentId: string | null;
  currentTitle: string;
  showCurrent: boolean; // the open table is a draft or preview that is not in the saved list
  mock: boolean;
  onNew: () => void;
  onDelete: (id: string) => void;
  onHide: () => void;
}) {
  const now = useNow();

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
        New table
      </button>

      <nav className="recent" aria-label="Recent tables">
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
            return (
              <li key={t.id} className={cx("row", on && "on")}>
                <a className="row-link" href={`#/table/${t.id}`} aria-current={on ? "page" : undefined}>
                  <span className="row-title">{title}</span>
                  {on ? null : <span className="row-time">{shortTime(t.updatedAt, now)}</span>}
                </a>
                <button
                  type="button"
                  className="row-del"
                  aria-label={`Delete ${title}`}
                  title="Delete this table"
                  onClick={() => {
                    if (window.confirm(`Delete “${title}”? This removes it from this browser.`)) onDelete(t.id);
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {mock ? (
        <p className="side-foot">
          <b>Sample mode</b>
          <br />
          The app writes the replies itself.
        </p>
      ) : null}
    </aside>
  );
}
