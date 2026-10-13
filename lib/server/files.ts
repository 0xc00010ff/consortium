// Small helpers for the files the server keeps under ~/.consortium: private
// folders, atomic writes, and request bodies with a size limit.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Creates the folder, and any missing parents, with mode 0700. An existing
// folder keeps its mode.
export function makePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Writes the file with mode 0600, creating its folder with mode 0700 when
// needed. The new content goes to a temporary file in the same folder first
// and is then renamed into place, so a failed write never leaves half a file.
export function writeFileAtomic(file: string, content: string): void {
  makePrivateDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; status: number; error: string };

// Reads a JSON request body, stopping as soon as it passes maxBytes, so a
// huge body is never held in memory. A body over the limit answers 413 with
// tooLargeError.
export async function readJsonBody(request: Request, maxBytes: number, tooLargeError: string): Promise<JsonBody> {
  const tooLarge: JsonBody = { ok: false, status: 413, error: tooLargeError };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      chunks.push(value);
    }
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, error: "The request body must be valid JSON." };
  }
}
