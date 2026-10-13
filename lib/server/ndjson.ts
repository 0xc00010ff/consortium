// Writes SpeakEvents as newline-delimited JSON, one event per line.

import type { SpeakEvent } from "@/lib/types";

export const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
};

export function eventsResponse(events: AsyncGenerator<SpeakEvent>, onCancel: () => void): Response {
  const encoder = new TextEncoder();
  const line = (event: SpeakEvent) => encoder.encode(`${JSON.stringify(event)}\n`);

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(line(value));
      } catch (err) {
        console.error("The speak stream failed.", err);
        controller.enqueue(line({ type: "error", message: "The server failed while writing the reply. Try again." }));
        controller.close();
      }
    },
    async cancel() {
      // The client went away, for example because the table was stopped.
      onCancel();
      await events.return(undefined);
    },
  });

  return new Response(stream, { headers: NDJSON_HEADERS });
}
