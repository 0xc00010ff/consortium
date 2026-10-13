// GET /api/models: the models a seat can use, with defaults for a new table.
// Claude Code and Codex come first when they are installed on this machine.
// With a gateway key the gateway's models follow; with provider keys only,
// the models of those makers. Without any key the tools are the whole list.
// With no key and neither tool, or with CONSORTIUM_MOCK=1, it returns
// mock: true with the gateway's public model list, or a built-in list when
// offline. Keys come from the settings file or the environment.

import { getModelsResponse } from "@/lib/server/models";

// Read the settings, the environment and the gateway on every request, never at build time.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const models = await getModelsResponse();
    return Response.json(models, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("Loading the model list failed.", err);
    return Response.json(
      {
        error:
          "Could not load the model list from the AI Gateway. Check the gateway key in Settings and your network connection, then reload the page.",
      },
      { status: 502 },
    );
  }
}
