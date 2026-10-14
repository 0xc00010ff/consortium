// The settings modal's link to the server, and the settings this browser
// keeps for itself: the theme, the default setup for new tables, and the
// widths of the sidebar and the right panel.
//
// This file has no React imports, so the root layout can read THEME_KEY.

import type { SettingsResponse, SettingsUpdate } from "@/lib/types";

// ---------- the server ----------

async function readResponse(res: Response): Promise<SettingsResponse> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `The server answered with status ${res.status}.`);
  }
  return (await res.json()) as SettingsResponse;
}

// With reveal, each key that is set includes its whole value. With refresh,
// the server looks for Claude Code and Codex again before it answers.
export async function fetchSettings({ reveal = false, refresh = false } = {}): Promise<SettingsResponse> {
  const query = [reveal && "reveal=1", refresh && "refresh=1"].filter(Boolean).join("&");
  return readResponse(await fetch(query ? `/api/settings?${query}` : "/api/settings", { cache: "no-store" }));
}

// A null clears a value; a missing field is left alone.
export async function saveSettings(update: SettingsUpdate): Promise<SettingsResponse> {
  return readResponse(
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
}

// ---------- the theme ----------

// The layout's inline script reads this key before the first paint, so keep
// the two in step. "system" is stored as no key at all.
export const THEME_KEY = "consortium.theme";

export type Theme = "system" | "light" | "dark";

export function readTheme(): Theme {
  try {
    const t = window.localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
  try {
    if (theme === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage is unavailable. The theme still applies until the page closes.
  }
}

// ---------- the default setup for new tables ----------

// The id of a preset, built-in or saved. No key means the server's default.
export const DEFAULT_PRESET_KEY = "consortium.defaultPreset";

export function readDefaultPreset(): string {
  try {
    return window.localStorage.getItem(DEFAULT_PRESET_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setDefaultPreset(id: string) {
  try {
    if (id) window.localStorage.setItem(DEFAULT_PRESET_KEY, id);
    else window.localStorage.removeItem(DEFAULT_PRESET_KEY);
  } catch {
    // Storage is unavailable. New tables keep the server's default.
  }
}

// ---------- the widths of the side panels ----------

// The widths, in pixels, that each side panel can be dragged to. lib/ui/layout
// exports these too, next to the rules that use them.
export const SIDE = { min: 200, max: 420, default: 256 };
export const PANEL = { min: 320, max: 600, default: 380 };

const WIDTHS = {
  side: { key: "consortium.sidebarWidth", ...SIDE },
  panel: { key: "consortium.panelWidth", ...PANEL },
};

// The saved width, kept within that panel's limits, or the default when none is saved.
export function readWidth(which: "side" | "panel"): number {
  const w = WIDTHS[which];
  try {
    const stored = window.localStorage.getItem(w.key);
    const n = stored === null ? NaN : Number(stored);
    return Number.isFinite(n) ? Math.min(w.max, Math.max(w.min, Math.round(n))) : w.default;
  } catch {
    return w.default;
  }
}

export function saveWidth(which: "side" | "panel", value: number) {
  try {
    window.localStorage.setItem(WIDTHS[which].key, String(Math.round(value)));
  } catch {
    // Storage is unavailable. The width still applies until the page closes.
  }
}
