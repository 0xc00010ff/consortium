// GET /api/conversations/<id>: one saved conversation as { table }, or 404.
//
// PUT /api/conversations/<id> with { table }: saves the conversation and
// returns { summary }. When the saved copy has a later updatedAt than the
// incoming one, nothing is written and the answer is 409 with the saved
// { table }, so the browser can merge the two. ?force=1 saves anyway.
//
// DELETE /api/conversations/<id>: removes the saved conversation and answers
// 204, also when there was nothing to remove.
//
// Like the other routes, these have no sign-in. See "Local use only" in the
// README.

import type { TableResponse, TableSummary } from "@/lib/types";
import { isRecord, readJsonBody } from "@/lib/server/files";
import {
  INVALID_ID_ERROR,
  MAX_CONVERSATION_BYTES,
  checkConversation,
  deleteConversation,
  isValidConversationId,
  readConversation,
  writeConversation,
} from "@/lib/server/conversations";

// Read the folder on every request, never at build time.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

interface Context {
  params: Promise<{ id: string }>;
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

function failure(action: string, err: unknown): Response {
  console.error(`${action} failed.`, err);
  const message = err instanceof Error ? err.message : String(err);
  return error(500, `${action} failed. ${message}`);
}

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  if (!isValidConversationId(id)) return error(400, INVALID_ID_ERROR);
  try {
    const table = readConversation(id);
    if (!table) return error(404, "There is no saved conversation with this id.");
    const body: TableResponse = { table };
    return Response.json(body, { headers: NO_STORE });
  } catch (err) {
    return failure("Reading the conversation", err);
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  if (!isValidConversationId(id)) return error(400, INVALID_ID_ERROR);

  const body = await readJsonBody(request, MAX_CONVERSATION_BYTES, "The conversation is larger than 20 MB.");
  if (!body.ok) return error(body.status, body.error);
  if (!isRecord(body.value) || !("table" in body.value)) {
    return error(400, "The request body must be an object with a table field.");
  }
  const checked = checkConversation(body.value.table, id);
  if (!checked.ok) return error(400, checked.error);
  const table = checked.table;
  const force = new URL(request.url).searchParams.get("force") === "1";

  try {
    // Reading and writing are synchronous, so no other request can save this
    // conversation between the check and the write.
    if (!force) {
      const saved = readConversation(id);
      if (saved && saved.updatedAt > table.updatedAt) {
        const conflict: TableResponse = { table: saved };
        return Response.json(conflict, { status: 409, headers: NO_STORE });
      }
    }
    const summary: TableSummary = writeConversation(table);
    return Response.json({ summary }, { headers: NO_STORE });
  } catch (err) {
    return failure("Saving the conversation", err);
  }
}

export async function DELETE(_request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  if (!isValidConversationId(id)) return error(400, INVALID_ID_ERROR);
  try {
    deleteConversation(id);
  } catch (err) {
    return failure("Deleting the conversation", err);
  }
  return new Response(null, { status: 204, headers: NO_STORE });
}
