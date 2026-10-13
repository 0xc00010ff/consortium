"use client";

import { useSyncExternalStore } from "react";

// Below this width the sidebar and the right panel open over the conversation
// instead of beside it. The same query is written in app/globals.css, and the
// two must match.
export const COMPACT_QUERY = "(max-width: 1023px)";

// In the compact layout the sidebar and the right panel open one at a time as
// drawers over the conversation.
export type Drawer = "side" | "panel" | null;

// When a drawer opens, focus moves to the first of these inside it.
export const FOCUSABLE = "button:not(:disabled), a[href], input, select, textarea";

function subscribe(listener: () => void) {
  const media = window.matchMedia(COMPACT_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

function getSnapshot() {
  return window.matchMedia(COMPACT_QUERY).matches;
}

// True while the window is narrow enough for the compact layout. The server
// renders the wide layout.
export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
