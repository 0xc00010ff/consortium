import { readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsResponse, SettingsResponse } from "@/lib/types";
import { setCliToolDetector } from "@/lib/server/cliTools";
import { clearModelsCache, getModelsResponse } from "@/lib/server/models";
import { settingsPath, writeSettingsFile } from "@/lib/server/settings";
import { isolateSettings, removeSettingsDirs } from "@/lib/server/settingsHome.testkit";
import { setVersionRunner } from "@/lib/server/toolStatus";
import { GET, PUT } from "./route";

const saved = { ...process.env };
let detections = 0;
let versionRuns = 0;
let listFetches = 0;

beforeEach(() => {
  isolateSettings();
  delete process.env.CONSORTIUM_MOCK;
  clearModelsCache();
  detections = 0;
  versionRuns = 0;
  listFetches = 0;
  setCliToolDetector(() => {
    detections++;
    return [{ id: "cli/claude-code", bin: "/x/claude", configuredModel: "sonnet" }];
  });
  setVersionRunner(async () => {
    versionRuns++;
    return "2.1.290 (Claude Code)";
  });
  vi.stubGlobal("fetch", async () => {
    listFetches++;
    return new Response(
      JSON.stringify({
        data: [
          { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", type: "language" },
          { id: "openai/gpt-7-sol", name: "GPT-7 Sol", type: "language" },
        ],
      }),
      { status: 200 },
    );
  });
});

afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  setCliToolDetector(null);
  setVersionRunner(null);
  clearModelsCache();
  removeSettingsDirs();
});

function get(query = ""): Promise<Response> {
  return GET(new Request(`http://localhost/api/settings${query}`));
}

function put(body: unknown): Promise<Response> {
  return PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("GET /api/settings", () => {
  it("shows the last four characters of each key and where it comes from", async () => {
    writeSettingsFile({ keys: { anthropic: "sk-ant-secret-1234" }, toolPaths: {} });
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-9999";
    process.env.GEMINI_API_KEY = "gem-secret-abcd";
    const response = await get();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as SettingsResponse;
    expect(body.keys).toEqual({
      gateway: { set: false },
      anthropic: { set: true, last4: "1234", source: "settings" },
      openai: { set: false },
      google: { set: true, last4: "abcd", source: "env" },
      xai: { set: false },
    });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body.webSearch).toBe(false);
    expect(body.tools).toEqual([
      { id: "cli/claude-code", name: "Claude Code", installed: true, path: "/x/claude", version: "2.1.290", defaultModel: "Sonnet" },
      { id: "cli/codex", name: "Codex", installed: false },
    ]);
  });

  it("includes each set key's value with reveal=1", async () => {
    writeSettingsFile({ keys: { gateway: "vck_secret_5678" }, toolPaths: {} });
    const body = (await (await get("?reveal=1")).json()) as SettingsResponse;
    expect(body.keys.gateway).toEqual({ set: true, last4: "5678", source: "settings", value: "vck_secret_5678" });
    expect(body.keys.openai).toEqual({ set: false });
    expect(body.webSearch).toBe(true);
  });
});

describe("PUT /api/settings", () => {
  it("saves keys and tool paths with mode 0600 and returns the new status", async () => {
    const response = await put({ keys: { openai: "  sk-new-key-0001 " }, toolPaths: { codex: "/opt/codex" }, extra: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as SettingsResponse;
    expect(body.keys.openai).toEqual({ set: true, last4: "0001", source: "settings" });
    expect(body.tools[1]).toEqual({ id: "cli/codex", name: "Codex", installed: false, configuredPath: "/opt/codex" });
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      keys: { openai: "sk-new-key-0001" },
      toolPaths: { codex: "/opt/codex" },
    });
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
  });

  it("clears a value with null and leaves the others alone", async () => {
    writeSettingsFile({ keys: { openai: "sk-1111", xai: "xai-2222" }, toolPaths: { claude: "/a/claude" } });
    const body = (await (await put({ keys: { openai: null } })).json()) as SettingsResponse;
    expect(body.keys.openai).toEqual({ set: false });
    expect(body.keys.xai.set).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ keys: { xai: "xai-2222" }, toolPaths: { claude: "/a/claude" } });
  });

  it("rejects bad input with status 400 and writes nothing", async () => {
    const tooLong = await put({ keys: { gateway: "x".repeat(600) } });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: "The gateway key is longer than 512 characters." });
    expect((await put({ keys: { openai: 12 } })).status).toBe(400);
    expect((await put({ toolPaths: { claude: "claude" } })).status).toBe(400);
    expect((await put("{oops")).status).toBe(400);
    expect(() => statSync(settingsPath())).toThrow();
  });

  it("clears the model list, tool and version caches, so the next list reflects the change", async () => {
    writeSettingsFile({ keys: { openai: "sk-test-not-used" }, toolPaths: {} });
    const before: ModelsResponse = await getModelsResponse();
    expect(before.models.map((m) => m.id)).toEqual(["cli/claude-code", "openai/gpt-7-sol"]);
    await getModelsResponse();
    await get();
    expect(listFetches).toBe(1);
    const counts = { detections, versionRuns, listFetches };

    await put({ keys: { anthropic: "sk-ant-test-not-used" } });
    expect(detections).toBeGreaterThan(counts.detections);
    expect(versionRuns).toBeGreaterThan(counts.versionRuns);

    const after = await getModelsResponse();
    expect(listFetches).toBeGreaterThan(counts.listFetches);
    expect(after.models.map((m) => m.id)).toEqual(["cli/claude-code", "anthropic/claude-sonnet-5.5", "openai/gpt-7-sol"]);
  });
});
