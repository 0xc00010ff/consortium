// GET /api/models: the models a seat can use, with defaults for a new table.
// Claude Code and Codex come first when they are installed on this machine.
// Without AI_GATEWAY_API_KEY they are the whole list. With no key and neither
// tool, or with CONSORTIUM_MOCK=1, it returns mock: true with the gateway's
// public model list, or a built-in list when offline.

import { getModelsResponse } from "@/lib/server/models";

// Read the environment and the gateway on every request, never at build time.
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
          "Could not load the model list from the AI Gateway. Check AI_GATEWAY_API_KEY in .env.local and your network connection, then reload the page.",
      },
      { status: 502 },
    );
  }
}
