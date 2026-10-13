// The settings modal's link to the server, and the two settings this browser
// keeps for itself: the theme and the default setup for new tables.
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

// With reveal, each key that is set includes its whole value.
export async function fetchSettings(reveal = false): Promise<SettingsResponse> {
  return readResponse(await fetch(reveal ? "/api/settings?reveal=1" : "/api/settings", { cache: "no-store" }));
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
