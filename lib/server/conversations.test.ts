import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Table } from "@/lib/types";
import { isolateSettings, removeSettingsDirs } from "./settingsHome.testkit";
import {
  LIST_CACHE_MS,
  checkConversation,
  clearConversationsCache,
  deleteConversation,
  isValidConversationId,
  listConversations,
  readConversation,
  conversationsDir,
  writeConversation,
} from "./conversations";

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

describe("the conversations folder", () => {
  it("lives next to the settings file", () => {
    expect(conversationsDir()).toBe(path.join(home, "conversations"));
  });
});

describe("conversation ids", () => {
  it("accepts 1 to 80 letters, digits, hyphens and underscores", () => {
    expect(isValidConversationId("abc-DEF_123")).toBe(true);
    expect(isValidConversationId("x".repeat(80))).toBe(true);
    expect(isValidConversationId("x".repeat(81))).toBe(false);
    expect(isValidConversationId("")).toBe(false);
    expect(isValidConversationId("../settings")).toBe(false);
    expect(isValidConversationId("a.json")).toBe(false);
    expect(isValidConversationId("a b")).toBe(false);
    expect(isValidConversationId(12)).toBe(false);
  });

  it("are refused by every read, write and delete", () => {
    expect(() => readConversation("../settings")).toThrow(/letters, digits/);
    expect(() => deleteConversation("a/b")).toThrow(/letters, digits/);
    expect(() => writeConversation(makeTable("a.b", 1))).toThrow(/letters, digits/);
  });
});

describe("checkConversation", () => {
  it("checks the top-level fields and the id", () => {
    expect(checkConversation(makeTable("t1", 5), "t1").ok).toBe(true);
    expect(checkConversation([], "t1")).toEqual({ ok: false, error: "The conversation must be a JSON object." });
    expect(checkConversation(makeTable("t1", 5), "t2")).toEqual({
      ok: false,
      error: "The conversation id in the body does not match the id in the address.",
    });
    expect(checkConversation({ ...makeTable("t1", 5), title: 3 })).toEqual({ ok: false, error: "The conversation title must be a string." });
    expect(checkConversation({ ...makeTable("t1", 5), updatedAt: "5" })).toEqual({
      ok: false,
      error: "The conversation's updatedAt must be a number.",
    });
    expect(checkConversation({ ...makeTable("t1", 5), rounds: {} })).toEqual({ ok: false, error: "The conversation's rounds must be a list." });
    expect(checkConversation({ ...makeTable("t1", 5), privateThreads: [] })).toEqual({
      ok: false,
      error: "The conversation's privateThreads must be an object.",
    });
  });
});

describe("reading and writing", () => {
  it("round-trips a conversation, with a 0700 folder and a 0600 file", () => {
    const table = { ...makeTable("t1", 5), instructions: "Be brief.", rounds: [{ anything: true }] } as unknown as Table;
    expect(writeConversation(table)).toEqual({ id: "t1", title: "Table t1", createdAt: 1000, updatedAt: 5 });
    expect(readConversation("t1")).toEqual(table);
    const file = path.join(home, "conversations", "t1.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(table);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(home, "conversations")).mode & 0o777).toBe(0o700);
  });

  it("reads a missing conversation as null", () => {
    expect(readConversation("nothing")).toBeNull();
  });

  it("refuses to write a conversation that fails the check", () => {
    expect(() => writeConversation({ ...makeTable("t1", 5), seats: null } as unknown as Table)).toThrow(
      "The conversation's seats must be a list.",
    );
  });

  it("deletes a conversation, and deleting a missing one does nothing", () => {
    writeConversation(makeTable("t1", 5));
    deleteConversation("t1");
    expect(readConversation("t1")).toBeNull();
    expect(() => deleteConversation("t1")).not.toThrow();
    expect(listConversations()).toEqual([]);
  });
});

describe("listConversations", () => {
  it("lists nothing when the folder does not exist yet", () => {
    expect(listConversations()).toEqual([]);
  });

  it("lists summaries newest first by updatedAt", () => {
    writeConversation(makeTable("old", 10));
    writeConversation(makeTable("new", 30));
    writeConversation(makeTable("mid", 20));
    expect(listConversations()).toEqual([
      { id: "new", title: "Table new", createdAt: 1000, updatedAt: 30 },
      { id: "mid", title: "Table mid", createdAt: 1000, updatedAt: 20 },
      { id: "old", title: "Table old", createdAt: 1000, updatedAt: 10 },
    ]);
  });

  it("skips malformed files and other names with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConversation(makeTable("good", 10));
    const dir = path.join(home, "conversations");
    writeFileSync(path.join(dir, "broken.json"), "{ not json");
    writeFileSync(path.join(dir, "wrong.json"), JSON.stringify({ id: "wrong", title: 1 }));
    writeFileSync(path.join(dir, "mismatch.json"), JSON.stringify(makeTable("other", 99)));
    writeFileSync(path.join(dir, "notes.txt"), "hello");
    writeFileSync(path.join(dir, "good.json.123.tmp"), "{");
    expect(listConversations().map((t) => t.id)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("sees a write and a delete made through this module on the next call", () => {
    writeConversation(makeTable("a", 10));
    expect(listConversations().map((t) => t.id)).toEqual(["a"]);
    writeConversation(makeTable("b", 20));
    expect(listConversations().map((t) => t.id)).toEqual(["b", "a"]);
    writeConversation(makeTable("a", 30, "Renamed"));
    expect(listConversations()[0]).toEqual({ id: "a", title: "Renamed", createdAt: 1000, updatedAt: 30 });
    deleteConversation("b");
    expect(listConversations().map((t) => t.id)).toEqual(["a"]);
  });

  it("sees a file written by another process once the folder changes or the cache is old", () => {
    writeConversation(makeTable("a", 10));
    expect(listConversations().map((t) => t.id)).toEqual(["a"]);

    // A new file changes the folder, so the next listing rescans at once.
    const dir = path.join(home, "conversations");
    writeFileSync(path.join(dir, "b.json"), JSON.stringify(makeTable("b", 20)));
    expect(listConversations().map((t) => t.id)).toEqual(["b", "a"]);

    // Rewriting a file in place leaves the folder alone, so the cached
    // listing is used until it is more than five seconds old.
    const now = Date.now();
    writeFileSync(path.join(dir, "a.json"), JSON.stringify(makeTable("a", 40, "Edited elsewhere")));
    expect(listConversations()[0].id).toBe("b");
    vi.spyOn(Date, "now").mockReturnValue(now + LIST_CACHE_MS + 1);
    expect(listConversations()[0]).toEqual({ id: "a", title: "Edited elsewhere", createdAt: 1000, updatedAt: 40 });
  });

  it("follows CONSORTIUM_HOME when it changes", () => {
    writeConversation(makeTable("a", 10));
    expect(listConversations()).toHaveLength(1);
    const other = isolateSettings();
    mkdirSync(path.join(other, "conversations"));
    expect(listConversations()).toEqual([]);
  });
});
