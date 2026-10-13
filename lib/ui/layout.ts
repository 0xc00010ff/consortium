"use client";

import { useSyncExternalStore } from "react";

// The width limits live with the saved widths in settings.ts, which has to
// stay free of React for the root layout.
export { PANEL, SIDE } from "./settings";

// The conversation always keeps at least this much width. When the window is
// too narrow for it beside both side panels, the sidebar opens over the
// conversation instead. When it is too narrow beside the right panel alone,
// the right panel opens over it too.
export const MIN_MAIN = 480;

// "wide" shows both panels beside the conversation, "medium" shows only the
// right panel beside it, and "narrow" shows neither.
export type Layout = "wide" | "medium" | "narrow";

export function layoutFor(vw: number, sideW: number, panelW: number): Layout {
  if (vw >= sideW + panelW + MIN_MAIN) return "wide";
  if (vw >= panelW + MIN_MAIN) return "medium";
  return "narrow";
}

// A side panel that does not fit opens as a drawer over the conversation.
// Only one drawer is open at a time.
export type Drawer = "side" | "panel" | null;

// When a drawer opens, focus moves to the first of these inside it.
export const FOCUSABLE = "button:not(:disabled), a[href], input, select, textarea";

function subscribe(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

// The window's width in pixels. The server renders 0.
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, () => window.innerWidth, () => 0);
}
