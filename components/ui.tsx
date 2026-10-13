"use client";

import { useId, useState, type ReactNode } from "react";
import type { Attachment, ToolActivity } from "@/lib/types";
import { displayUrl } from "@/lib/ui/format";
import { STOPPED } from "@/lib/ui/storage";
import { Icon, type IconName } from "./Icon";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------- avatars ----------

export function SeatAvatar({ id, small }: { id: string; small?: boolean }) {
  return (
    <span className={cx("av", `seat-${id.toLowerCase()}`, small && "sm")} aria-hidden="true">
      {id}
    </span>
  );
}

export function HostAvatar({ small }: { small?: boolean }) {
  return (
    <span className={cx("av host", small && "sm")} aria-hidden="true">
      <Icon name="user" size={small ? 12 : 14} />
    </span>
  );
}

export function ArbiterAvatar({ small }: { small?: boolean }) {
  return (
    <span className={cx("av arb", small && "sm")} aria-hidden="true">
      <Icon name="scale" size={small ? 12 : 14} />
    </span>
  );
}

// ---------- controls ----------

export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
  className,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cx("ibtn", className)}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  title?: string; // the tooltip, when it should differ from the accessible name
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

// A small two-option toggle group.
export function Toggle<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: Array<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="toggle" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- attachments ----------

export function Thumbs({ attachments }: { attachments?: Attachment[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="thumbs">
      {attachments.map((a) => (
        <figure className="thumb" key={a.id} title={a.name}>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL preview */}
          <img src={a.dataUrl} alt={a.name} />
        </figure>
      ))}
    </div>
  );
}

export function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  return (
    <span className="att">
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL preview */}
      <img src={attachment.dataUrl} alt="" />
      <span className="att-name" title={attachment.name}>
        {attachment.name}
      </span>
      <button type="button" className="att-x" onClick={onRemove} aria-label={`Remove ${attachment.name}`}>
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

// ---------- tool activity ----------

function toolText(t: ToolActivity): string {
  const search = t.tool === "web_search";
  const what = search ? `“${t.label}”` : displayUrl(t.label);
  if (t.status === "running") return search ? `Searching the web for ${what}` : `Reading ${what}`;
  if (t.status === "error" && t.detail === STOPPED) return search ? `Stopped searching for ${what}` : `Stopped reading ${what}`;
  if (t.status === "error") return search ? `The web search for ${what} failed` : `Could not read ${what}`;
  return search ? `Searched the web for ${what}` : `Read ${what}`;
}

const times = (n: number) => (n === 1 ? "once" : `${n} times`);
const pages = (n: number) => (n === 1 ? "1 page" : `${n} pages`);

// One line for all of a reply's tool activity. While a tool runs it says what
// is happening now; after that it counts the searches and pages read.
export function toolSummary(tools: ToolActivity[]): string {
  const running = [...tools].reverse().find((t) => t.status === "running");
  let label: string;
  if (running) {
    label = running.tool === "web_search" ? "Searching the web" : "Reading a page";
  } else {
    const searches = tools.filter((t) => t.tool === "web_search").length;
    const reads = tools.length - searches;
    if (searches && reads) label = `Searched the web ${times(searches)} and read ${pages(reads)}`;
    else if (searches) label = `Searched the web ${times(searches)}`;
    else label = `Read ${pages(reads)}`;
  }
  const failed = tools.filter((t) => t.status === "error" && t.detail !== STOPPED).length;
  return failed ? `${label} · ${failed} failed` : label;
}

// A summary row that opens to show each tool as a chip. Closed by default.
export function ToolChips({ tools }: { tools: ToolActivity[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!tools.length) return null;
  return (
    <div className="tools">
      <button
        type="button"
        className={cx("tools-sum", tools.some((t) => t.status === "running") && "running")}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        {toolSummary(tools)}
      </button>
      <div id={listId} className="tools-list" hidden={!open}>
        {tools.map((t) => {
          const text = toolText(t);
          const title = t.detail && t.detail !== STOPPED ? `${text}. ${t.detail}` : text;
          return (
            <span key={t.id} className={cx("tool", t.status === "error" && t.detail === STOPPED ? "stopped" : t.status)} title={title}>
              <Icon name={t.tool === "web_search" ? "search" : "file"} size={12} />
              <span>{t.tool === "web_search" ? t.label : displayUrl(t.label)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------- notes ----------

export function Banner({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="banner" role="alert">
      <Icon name="alert" />
      <span>{children}</span>
      {action}
    </div>
  );
}
