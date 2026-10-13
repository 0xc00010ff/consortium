// GET /api/conversations: the summary of every saved conversation, newest
// first, as { tables }. Conversations are saved in ~/.consortium/conversations
// (or $CONSORTIUM_HOME/conversations), one file each.
//
// Like the other routes, this has no sign-in, since the app is meant to run
// on the host's own machine. See "Local use only" in the README.

import type { TablesResponse } from "@/lib/types";
import { listConversations } from "@/lib/server/conversations";

// Read the folder on every request, never at build time.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  try {
    const body: TablesResponse = { tables: listConversations() };
    return Response.json(body, { headers: NO_STORE });
  } catch (err) {
    console.error("Listing the saved conversations failed.", err);
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `The saved conversations could not be listed. ${message}` }, { status: 500, headers: NO_STORE });
  }
}
