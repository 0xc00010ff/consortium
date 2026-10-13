// Saved presets: one JSON array in ~/.consortium/presets.json (or
// $CONSORTIUM_HOME/presets.json). The browser owns the shape of a preset, so
// the server checks only that each one is an object with a string id and name.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Preset } from "@/lib/types";
import { isRecord, writeFileAtomic } from "./files";
import { settingsDir, type Env } from "./settings";

export const MAX_PRESETS_BYTES = 2 * 1024 * 1024;

export function presetsPath(env: Env = process.env): string {
  return path.join(settingsDir(env), "presets.json");
}

export type CheckedPresets = { ok: true; presets: Preset[] } | { ok: false; error: string };

export function checkPresets(value: unknown): CheckedPresets {
  if (!Array.isArray(value)) return { ok: false, error: "presets must be a list." };
  for (const [index, preset] of value.entries()) {
    const label = `Preset ${index + 1}`;
    if (!isRecord(preset)) return { ok: false, error: `${label} must be an object.` };
    if (typeof preset.id !== "string" || !preset.id) return { ok: false, error: `${label} needs a string id.` };
    if (typeof preset.name !== "string") return { ok: false, error: `${label} needs a string name.` };
  }
  return { ok: true, presets: value as Preset[] };
}

// The saved presets. A missing file reads as none. In a malformed file, the
// entries without a string id and name are dropped with a warning.
export function readPresets(file: string = presetsPath()): Preset[] {
  let raw: unknown;
  try {
    // The file is outside the project, so the build should not trace it.
    raw = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Could not read the saved presets ${file}.`, err);
    return [];
  }
  if (!Array.isArray(raw)) {
    console.warn(`Ignoring the saved presets ${file}, because it is not a list.`);
    return [];
  }
  const presets = raw.filter((preset) => checkPresets([preset]).ok) as Preset[];
  if (presets.length !== raw.length) console.warn(`Skipped ${raw.length - presets.length} malformed presets in ${file}.`);
  return presets;
}

// Replaces the saved presets, with mode 0600 in a 0700 folder.
export function writePresets(presets: Preset[], file: string = presetsPath()): void {
  const checked = checkPresets(presets);
  if (!checked.ok) throw new Error(checked.error);
  writeFileAtomic(file, `${JSON.stringify(presets, null, 2)}\n`);
}
