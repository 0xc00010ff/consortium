import { existsSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Preset, PresetsResponse } from "@/lib/types";
import { MAX_PRESETS_BYTES, presetsPath } from "@/lib/server/presets";
import { isolateSettings, removeSettingsDirs } from "@/lib/server/settingsHome.testkit";
import { GET, PUT } from "./route";

const saved = { ...process.env };

beforeEach(() => {
  isolateSettings();
});

afterEach(() => {
  process.env = { ...saved };
  removeSettingsDirs();
});

const preset: Preset = {
  id: "p1",
  name: "Two critics",
  createdAt: 1000,
  interaction: "group",
  instructions: "Disagree politely.",
  seats: [],
  arbiters: [],
};

function put(body: unknown): Promise<Response> {
  return PUT(
    new Request("http://localhost/api/presets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("/api/presets", () => {
  it("lists no presets before any are saved", async () => {
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ presets: [] });
  });

  it("saves the whole list and returns it", async () => {
    const response = await put({ presets: [preset] });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as PresetsResponse).toEqual({ presets: [preset] });
    expect(await (await GET()).json()).toEqual({ presets: [preset] });
    expect(statSync(presetsPath()).mode & 0o777).toBe(0o600);

    await put({ presets: [] });
    expect(await (await GET()).json()).toEqual({ presets: [] });
  });

  it("answers 400 for a wrong body and writes nothing", async () => {
    const noName = await put({ presets: [{ id: "p1" }] });
    expect(noName.status).toBe(400);
    expect(await noName.json()).toEqual({ error: "Preset 1 needs a string name." });
    expect((await put({ presets: {} })).status).toBe(400);
    expect((await put([preset])).status).toBe(400);
    expect((await put("{oops")).status).toBe(400);
    expect(existsSync(presetsPath())).toBe(false);
  });

  it("answers 413 for a body over 2 MB", async () => {
    const response = await put({ presets: [{ ...preset, instructions: "x".repeat(MAX_PRESETS_BYTES) }] });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "The presets are larger than 2 MB." });
    expect(existsSync(presetsPath())).toBe(false);
  });
});
