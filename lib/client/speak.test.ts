// The speak client against the real /api/speak handler in mock mode, and the
// main flows run end to end: store, context builders, speak client, route
// and mock replies.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelsResponse, SpeakRequest, ToolActivity } from "@/lib/types";
import { POST } from "@/app/api/speak/route";
import { tableToMarkdown } from "@/lib/engine/export";
import { createTableStore } from "@/lib/engine/store";
import { newArbiter, newTable } from "@/lib/engine/table";
import { lastRound, waitFor } from "@/lib/engine/test-helpers";
import { MOCK_MODELS, mockModelsResponse } from "@/lib/server/models";
import { speak } from "./speak";

const saved = { ...process.env };
const realFetch = globalThis.fetch;

beforeAll(() => {
  process.env.CONSORTIUM_MOCK = "1";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    POST(new Request("http://localhost/api/speak", init))) as typeof fetch;
});

beforeEach(() => {
  process.env.CONSORTIUM_MOCK_DELAY = "0";
});

afterAll(() => {
  globalThis.fetch = realFetch;
  process.env = saved;
});

const models: ModelsResponse = mockModelsResponse();
const message = (text: string) => ({ text, attachments: [] });

function seatRequest(text: string, browsing = false): SpeakRequest {
  return {
    modelId: MOCK_MODELS[0].id,
    instructions: "You are Agent A at a table with agents B, C and D.",
    messages: [{ role: "user", text: "", afterAttachments: `# Now\n\nRound 1. The host wrote:\n\n${text}` }],
    browsing,
    mockHint: { purpose: "seat", interaction: "group", round: 1, seatId: "A" },
  };
}

describe("speak client", () => {
  it("streams text and returns the full reply with usage", async () => {
    const deltas: string[] = [];
    const result = await speak(
      seatRequest("How do I keep a remote team aligned?"),
      { onText: (d) => deltas.push(d) },
      new AbortController().signal,
    );
    expect(deltas.length).toBeGreaterThan(5);
    expect(deltas.join("")).toBe(result.text);
    expect(result.text).toContain("How do I keep a remote team aligned");
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.tools).toEqual([]);
  });

  it("reports tool activity as it happens", async () => {
    let seen: ToolActivity[] = [];
    for (let i = 0; i < 40 && seen.length === 0; i++) {
      const snapshots: ToolActivity[][] = [];
      const result = await speak(
        seatRequest(`Question number ${i} about solar panels`, true),
        { onTools: (t) => snapshots.push(t) },
        new AbortController().signal,
      );
      if (snapshots.length === 0) continue;
      expect(snapshots[0][0].status).toBe("running");
      expect(result.tools.every((t) => t.status === "done")).toBe(true);
      seen = result.tools;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].tool).toBe("web_search");
  });

  it("rejects with the server's message on a bad request", async () => {
    await expect(
      speak({ modelId: "", instructions: "", messages: [], browsing: false }, {}, new AbortController().signal),
    ).rejects.toThrow("The request is missing a model id.");
  });

  it("rejects with an AbortError when stopped", async () => {
    process.env.CONSORTIUM_MOCK_DELAY = "1";
    const controller = new AbortController();
    const pending = speak(seatRequest("Hello"), {}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("mock mode flows, end to end", () => {
  it("runs two rounds with a note, an arbiter added between rounds, a private conversation, and a switch to Independent", async () => {
    const store = createTableStore(newTable(models, models.models), speak);
    expect(store.getTable().seats).toHaveLength(4);

    await store.sendRound(message("How should a small team plan its first product launch?"));
    let table = store.getTable();
    expect(table.title).toBe("How should a small team plan its…");
    expect(lastRound(table).replies.every((r) => r.status === "done" && r.text.length > 50)).toBe(true);

    // An arbiter added between rounds answers in the next round.
    const arbiter = { ...newArbiter(table, models.defaults.arbiter, models.models), name: "Tracker", instructions: "Track the ideas." };
    store.edit({ arbiters: [arbiter] });
    await store.sendRound(message("Assume we can build only one thing this quarter."));
    table = store.getTable();
    const round2 = lastRound(table);
    expect(round2.status).toBe("done");
    expect(round2.replies.every((r) => /Agent [A-D]/.test(r.text))).toBe(true);
    expect(round2.arbiterReplies[0].status).toBe("done");
    expect(round2.arbiterReplies[0].text).toMatch(/^1\. Agent A wants to /m);

    // A private conversation with two exchanges.
    await store.sendPrivate("B", message("What would you cut first?"));
    await store.sendPrivate("B", message("And what would you keep?"));
    const thread = store.getTable().privateThreads.B ?? [];
    expect(thread.map((m) => `${m.role} ${m.status}`)).toEqual(["host done", "seat done", "host done", "seat done"]);
    expect(thread[1].text).toContain('You asked "What would you cut first".');
    expect(thread[3].text).toContain("That builds on what we discussed");

    // Independent applies from the next round.
    store.edit({ interaction: "independent" });
    await store.sendRound(message(""));
    const round3 = lastRound(store.getTable());
    expect(round3.interaction).toBe("independent");
    expect(round3.replies.every((r) => r.status === "done" && !/Agent [A-H]/.test(r.text))).toBe(true);
    expect(round3.replies[0].text).toContain("You added no note");

    const markdown = tableToMarkdown(store.getTable());
    expect(markdown).toContain("## Round 3");
    expect(markdown).toContain("### Private conversation with Agent B, after round 2");
    expect(markdown).toContain("### Tracker · Arbiter · Claude Opus 5.5");
  });

  it("stops mid-round, keeps partial text, and runs the next round", async () => {
    process.env.CONSORTIUM_MOCK_DELAY = "1";
    const store = createTableStore(newTable(models, models.models), speak);
    const pending = store.sendRound(message("Write a short plan for a product launch."));
    await waitFor(store, (t) => lastRound(t).replies.some((r) => r.text.length > 0), 5000);
    store.stop();
    await pending;

    const stopped = lastRound(store.getTable());
    expect(stopped.status).toBe("stopped");
    expect(stopped.replies.every((r) => r.status === "error" && r.error === "Stopped")).toBe(true);
    expect(stopped.replies.some((r) => r.text.length > 0)).toBe(true);

    process.env.CONSORTIUM_MOCK_DELAY = "0";
    await store.sendRound(message("Try again."));
    expect(lastRound(store.getTable()).status).toBe("done");
  });
});
