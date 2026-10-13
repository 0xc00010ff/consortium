// A time limit for one model call. When it runs out, the call is aborted and
// the client gets one plain error event.

import type { SpeakEvent } from "@/lib/types";

export const SPEAK_TIME_LIMIT_MS = 5 * 60 * 1000;
export const TIME_LIMIT_MESSAGE =
  "The model did not answer within 5 minutes, so the call was stopped. Try again, or choose a different model.";

export async function* withTimeLimit(
  events: AsyncGenerator<SpeakEvent>,
  limitMs: number,
  onTimeout: () => void,
  message: string = TIME_LIMIT_MESSAGE,
): AsyncGenerator<SpeakEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), limitMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([events.next(), expired]);
      if (next === "expired") {
        onTimeout();
        events.return(undefined).catch(() => {});
        yield { type: "error", message };
        return;
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    clearTimeout(timer);
  }
}
