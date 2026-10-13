"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Attachment, SeatColor, ToolActivity } from "@/lib/types";
import { displayUrl } from "@/lib/ui/format";
import { STOPPED } from "@/lib/ui/storage";
import { Icon, type IconName } from "./Icon";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------- avatars ----------

// The agent's letter on its color. Use seatColor() from lib/ui/view for `color`.
export function SeatAvatar({ id, color, small }: { id: string; color: SeatColor; small?: boolean }) {
  return (
    <span className={cx("av", `color-${color}`, small && "sm")} aria-hidden="true">
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

// ---------- menus ----------

// A small popover menu under its button, aligned to the button's right edge,
// or its left edge with align="start". It flips above the button when there
// is no room below. It opens with focus on the checked item, if any. Arrow keys move
// between items, and ArrowRight reaches an item's side button (marked
// data-side, inside a .menu-line). Escape or Tab closes it and returns focus
// to the button; so does onClose(true) from the caller. A press outside, a
// scroll that moves the button, or a resize closes it without moving focus.
export function Menu({
  anchor,
  label,
  align = "end",
  onClose,
  children,
}: {
  anchor: HTMLElement;
  label: string;
  align?: "start" | "end";
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useLayoutEffect(() => {
    closeRef.current = onClose;
  });

  // Placed on every render, since the items can change while it is open.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const height = el.offsetHeight;
    const below = a.bottom + 4;
    el.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, a.top - 4 - height) : below}px`;
    if (align === "start") {
      el.style.right = "auto";
      el.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - el.offsetWidth - 8))}px`;
    } else {
      el.style.right = `${Math.max(8, window.innerWidth - a.right)}px`;
    }
    el.style.visibility = "visible";
  });

  useLayoutEffect(() => {
    const items = primaryItems(ref.current);
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }, []);

  useEffect(() => {
    const close = () => closeRef.current(false);
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      close();
    }
    function onScroll(e: Event) {
      if (e.target instanceof Node && e.target.contains(anchor)) close();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose(true);
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const line = active?.closest(".menu-line");
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const target = line?.querySelector<HTMLElement>(e.key === "ArrowRight" ? "[data-side]" : ITEM);
      if (target) {
        e.preventDefault();
        target.focus();
      }
      return;
    }
    const items = primaryItems(ref.current);
    const current = active?.hasAttribute("data-side") ? line?.querySelector<HTMLElement>(ITEM) : active;
    const at = items.indexOf(current as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  }

  return (
    <div ref={ref} className="menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

const ITEM = '[role="menuitem"]:not([data-side]), [role="menuitemradio"]';

function primaryItems(menu: HTMLElement | null): HTMLElement[] {
  return [...(menu?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
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
