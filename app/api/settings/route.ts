// GET /api/settings: the status of each API key and of Claude Code and Codex.
// Keys show only their last four characters; ?reveal=1 adds each key's whole
// value, for the settings modal's show button. ?refresh=1 first clears the
// saved model list, tool search and versions, so a tool the host just
// installed or signed in to shows at once.
//
// PUT /api/settings: saves keys, tool paths and setupDone to
// ~/.consortium/settings.json (or $CONSORTIUM_HOME/settings.json) and returns
// the new status. A null or empty value clears a setting, and a missing field
// is left alone.
//
// Like the other routes, these have no sign-in, since the app is meant to run
// on the host's own machine. See "Local use only" in the README.

import type { SettingsResponse } from "@/lib/types";
import { applySettingsUpdate, parseSettingsUpdate, readSettingsFile, writeSettingsFile } from "@/lib/server/settings";
import { clearSettingsCaches, getSettingsResponse } from "@/lib/server/settingsResponse";

// Read the settings file on every request, never at build time.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const reveal = params.get("reveal") === "1";
  if (params.get("refresh") === "1") clearSettingsCaches();
  const body: SettingsResponse = await getSettingsResponse({ reveal });
  return Response.json(body, { headers: NO_STORE });
}

export async function PUT(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The request body must be valid JSON." }, { status: 400, headers: NO_STORE });
  }
  const parsed = parseSettingsUpdate(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  try {
    writeSettingsFile(applySettingsUpdate(readSettingsFile(), parsed.update));
  } catch (err) {
    console.error("Saving the settings failed.", err);
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `The settings could not be saved. ${message}` }, { status: 500, headers: NO_STORE });
  }
  clearSettingsCaches();
  return Response.json(await getSettingsResponse(), { headers: NO_STORE });
}
