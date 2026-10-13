import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Table, TableResponse, TablesResponse } from "@/lib/types";
import { isolateSettings, removeSettingsDirs } from "@/lib/server/settingsHome.testkit";
import { MAX_CONVERSATION_BYTES, clearConversationsCache, readConversation, writeConversation } from "@/lib/server/conversations";
import { GET as list } from "./route";
import { DELETE, GET, PUT } from "./[id]/route";

const saved = { ...process.env };
let home: string;

beforeEach(() => {
  home = isolateSettings();
  clearConversationsCache();
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
  clearConversationsCache();
  removeSettingsDirs();
});

function makeTable(id: string, updatedAt: number, title = `Table ${id}`): Table {
  return {
    id,
    title,
    createdAt: 1000,
    updatedAt,
    interaction: "group",
    seats: [],
    arbiters: [],
    rounds: [],
    privateThreads: {},
  };
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/conversations/${id}`), context(id));
}

function put(id: string, body: unknown, query = ""): Promise<Response> {
  return PUT(
    new Request(`http://localhost/api/conversations/${id}${query}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    context(id),
  );
}

function del(id: string): Promise<Response> {
  return DELETE(new Request(`http://localhost/api/conversations/${id}`, { method: "DELETE" }), context(id));
}

describe("GET /api/conversations", () => {
  it("lists the saved conversations newest first and skips a malformed file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConversation(makeTable("old", 10));
    writeConversation(makeTable("new", 20));
    writeFileSync(path.join(home, "conversations", "broken.json"), "{");
    const response = await list();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as TablesResponse;
    expect(body.tables.map((t) => t.id)).toEqual(["new", "old"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("lists nothing before any conversation is saved", async () => {
    expect(await (await list()).json()).toEqual({ tables: [] });
  });

  it("shows a conversation saved by the PUT route on the next listing", async () => {
    await list();
    await put("t1", { table: makeTable("t1", 5) });
    expect(((await (await list()).json()) as TablesResponse).tables.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("GET /api/conversations/<id>", () => {
  it("returns the saved conversation", async () => {
    writeConversation(makeTable("t1", 5));
    const response = await get("t1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ table: makeTable("t1", 5) });
  });

  it("answers 404 for a conversation that is not saved", async () => {
    const response = await get("missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "There is no saved conversation with this id." });
  });

  it("answers 400 for an invalid id", async () => {
    const response = await get("..%2Fsettings");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A conversation id must be 1 to 80 letters, digits, hyphens or underscores.",
    });
  });
});

describe("PUT /api/conversations/<id>", () => {
  it("saves the conversation and returns its summary", async () => {
    const response = await put("t1", { table: makeTable("t1", 5) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ summary: { id: "t1", title: "Table t1", createdAt: 1000, updatedAt: 5 } });
    expect(readConversation("t1")).toEqual(makeTable("t1", 5));
    expect(statSync(path.join(home, "conversations", "t1.json")).mode & 0o777).toBe(0o600);
  });

  it("saves over an older or equal copy", async () => {
    writeConversation(makeTable("t1", 5));
    expect((await put("t1", { table: makeTable("t1", 5, "Same time") })).status).toBe(200);
    expect((await put("t1", { table: makeTable("t1", 6, "Later") })).status).toBe(200);
    expect(readConversation("t1")?.title).toBe("Later");
  });

  it("answers 409 with the saved copy when it is newer, and writes nothing", async () => {
    writeConversation(makeTable("t1", 50, "Newer on disk"));
    const response = await put("t1", { table: makeTable("t1", 40, "Older in browser") });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as TableResponse).toEqual({ table: makeTable("t1", 50, "Newer on disk") });
    expect(readConversation("t1")?.title).toBe("Newer on disk");
  });

  it("saves over a newer copy with force=1", async () => {
    writeConversation(makeTable("t1", 50, "Newer on disk"));
    const response = await put("t1", { table: makeTable("t1", 40, "Kept by host") }, "?force=1");
    expect(response.status).toBe(200);
    expect(readConversation("t1")?.title).toBe("Kept by host");
  });

  it("answers 400 when the ids differ or the body is wrong, and writes nothing", async () => {
    const mismatch = await put("t1", { table: makeTable("t2", 5) });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: "The conversation id in the body does not match the id in the address." });
    expect((await put("bad.id", { table: makeTable("bad.id", 5) })).status).toBe(400);
    expect((await put("t1", makeTable("t1", 5))).status).toBe(400);
    expect((await put("t1", { table: { ...makeTable("t1", 5), seats: "none" } })).status).toBe(400);
    const notJson = await put("t1", "{oops");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "The request body must be valid JSON." });
    expect(existsSync(path.join(home, "conversations"))).toBe(false);
  });

  it("answers 413 for a body over 20 MB", async () => {
    const table = { ...makeTable("t1", 5), instructions: "x".repeat(MAX_CONVERSATION_BYTES) };
    const response = await put("t1", { table });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "The conversation is larger than 20 MB." });
    expect(readConversation("t1")).toBeNull();
  });
});

describe("DELETE /api/conversations/<id>", () => {
  it("removes the conversation and answers 204, also when it is not saved", async () => {
    writeConversation(makeTable("t1", 5));
    const response = await del("t1");
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readConversation("t1")).toBeNull();
    expect((await del("t1")).status).toBe(204);
    expect((await list().then((r) => r.json())) as TablesResponse).toEqual({ tables: [] });
  });

  it("answers 400 for an invalid id", async () => {
    expect((await del("a b")).status).toBe(400);
  });
});
