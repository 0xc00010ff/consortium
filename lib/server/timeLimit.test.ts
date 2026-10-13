import { describe, expect, it } from "vitest";
import type { SpeakEvent } from "@/lib/types";
import { TIME_LIMIT_MESSAGE, withTimeLimit } from "./timeLimit";

async function collect(events: AsyncGenerator<SpeakEvent>): Promise<SpeakEvent[]> {
  const out: SpeakEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("withTimeLimit", () => {
  it("ends a hung call with one plain error and aborts it", async () => {
    const controller = new AbortController();
    async function* hung(): AsyncGenerator<SpeakEvent> {
      yield { type: "text", delta: "Starting" };
      await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve()));
    }
    const events = await collect(withTimeLimit(hung(), 30, () => controller.abort()));
    expect(events).toEqual([
      { type: "text", delta: "Starting" },
      { type: "error", message: TIME_LIMIT_MESSAGE },
    ]);
    expect(controller.signal.aborted).toBe(true);
    expect(TIME_LIMIT_MESSAGE).toContain("did not answer within 5 minutes");
  });

  it("passes a call that finishes in time through unchanged", async () => {
    let timedOut = false;
    async function* quick(): AsyncGenerator<SpeakEvent> {
      yield { type: "text", delta: "Hi" };
      yield { type: "done", usage: {}, durationMs: 1, finishReason: "stop" };
    }
    const events = await collect(withTimeLimit(quick(), 1000, () => (timedOut = true)));
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
    expect(timedOut).toBe(false);
  });
});
