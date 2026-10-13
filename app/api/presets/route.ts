// GET /api/presets: the saved presets, from ~/.consortium/presets.json (or
// $CONSORTIUM_HOME/presets.json).
//
// PUT /api/presets with { presets }: replaces the whole list and returns the
// saved { presets }.
//
// Like the other routes, these have no sign-in. See "Local use only" in the
// README.

import type { PresetsResponse } from "@/lib/types";
import { isRecord, readJsonBody } from "@/lib/server/files";
import { MAX_PRESETS_BYTES, checkPresets, readPresets, writePresets } from "@/lib/server/presets";

// Read the file on every request, never at build time.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

export async function GET(): Promise<Response> {
  const body: PresetsResponse = { presets: readPresets() };
  return Response.json(body, { headers: NO_STORE });
}

export async function PUT(request: Request): Promise<Response> {
  const body = await readJsonBody(request, MAX_PRESETS_BYTES, "The presets are larger than 2 MB.");
  if (!body.ok) return error(body.status, body.error);
  if (!isRecord(body.value)) return error(400, "The request body must be an object with presets.");
  const checked = checkPresets(body.value.presets);
  if (!checked.ok) return error(400, checked.error);
  try {
    writePresets(checked.presets);
  } catch (err) {
    console.error("Saving the presets failed.", err);
    const message = err instanceof Error ? err.message : String(err);
    return error(500, `The presets could not be saved. ${message}`);
  }
  const saved: PresetsResponse = { presets: readPresets() };
  return Response.json(saved, { headers: NO_STORE });
}
