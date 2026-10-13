import { describe, expect, it } from "vitest";
import { readJsonBody } from "./files";

function streamed(text: string, chunk = 4): Request {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
  return new Request("http://localhost/x", { method: "PUT", body, duplex: "half" } as RequestInit);
}

describe("readJsonBody", () => {
  it("parses a body within the limit", async () => {
    expect(await readJsonBody(streamed('{"a":[1,2]}'), 100, "Too big.")).toEqual({ ok: true, value: { a: [1, 2] } });
  });

  it("stops reading once a streamed body passes the limit", async () => {
    expect(await readJsonBody(streamed(`"${"x".repeat(50)}"`), 20, "Too big.")).toEqual({
      ok: false,
      status: 413,
      error: "Too big.",
    });
  });

  it("refuses a declared length over the limit without reading", async () => {
    const request = new Request("http://localhost/x", {
      method: "PUT",
      body: "{}",
      headers: { "content-length": "999" },
    });
    expect(await readJsonBody(request, 20, "Too big.")).toMatchObject({ ok: false, status: 413 });
  });

  it("answers 400 for invalid or empty JSON", async () => {
    expect(await readJsonBody(streamed("{oops"), 100, "Too big.")).toMatchObject({ ok: false, status: 400 });
    expect(await readJsonBody(new Request("http://localhost/x", { method: "PUT" }), 100, "Too big.")).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});
