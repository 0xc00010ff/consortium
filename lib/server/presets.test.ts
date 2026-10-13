import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Preset } from "@/lib/types";
import { checkPresets, presetsPath, readPresets, writePresets } from "./presets";
import { isolateSettings, removeSettingsDirs } from "./settingsHome.testkit";

const saved = { ...process.env };
let home: string;

beforeEach(() => {
  home = isolateSettings();
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
  removeSettingsDirs();
});

const preset: Preset = {
  id: "p1",
  name: "Two critics",
  createdAt: 1000,
  interaction: "independent",
  seats: [],
  arbiters: [],
};

describe("presets", () => {
  it("live in presets.json next to the settings file", () => {
    expect(presetsPath()).toBe(path.join(home, "presets.json"));
  });

  it("read as none when the file is missing", () => {
    expect(readPresets()).toEqual([]);
  });

  it("round-trip with mode 0600", () => {
    writePresets([preset, { ...preset, id: "p2", name: "Other" }]);
    expect(readPresets()).toEqual([preset, { ...preset, id: "p2", name: "Other" }]);
    expect(JSON.parse(readFileSync(presetsPath(), "utf8"))).toHaveLength(2);
    expect(statSync(presetsPath()).mode & 0o777).toBe(0o600);
  });

  it("drop malformed entries and files with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(presetsPath(), JSON.stringify([preset, { id: 3, name: "x" }, "nope"]));
    expect(readPresets()).toEqual([preset]);
    writeFileSync(presetsPath(), "{ not json");
    expect(readPresets()).toEqual([]);
    writeFileSync(presetsPath(), JSON.stringify({ presets: [] }));
    expect(readPresets()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("must be a list of objects with a string id and name", () => {
    expect(checkPresets([preset]).ok).toBe(true);
    expect(checkPresets({})).toEqual({ ok: false, error: "presets must be a list." });
    expect(checkPresets([preset, 4])).toEqual({ ok: false, error: "Preset 2 must be an object." });
    expect(checkPresets([{ ...preset, id: "" }])).toEqual({ ok: false, error: "Preset 1 needs a string id." });
    expect(checkPresets([{ ...preset, name: null }])).toEqual({ ok: false, error: "Preset 1 needs a string name." });
    expect(() => writePresets([{ ...preset, name: 1 } as unknown as Preset])).toThrow("Preset 1 needs a string name.");
  });
});
