import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUserId } from "@/lib/session";
import { createConnection, syncSimplefinConnection, SimplefinError } from "@/lib/simplefin";

const schema = z.object({ setupToken: z.string().min(1).max(2000) });

// Claims a SimpleFIN setup token (single-use) and runs the first sync.
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { setupToken } = schema.parse(await req.json());
    const conn = await createConnection(userId, setupToken);
    try {
      const summary = await syncSimplefinConnection(conn.id, userId, { force: true });
      return NextResponse.json({ connectionId: conn.id, ...summary });
    } catch (e: any) {
      // The token is spent either way — keep the connection so a later sync
      // can retry, rather than making the user generate a new token.
      return NextResponse.json({ connectionId: conn.id, syncError: e?.message ?? "First sync failed" });
    }
  } catch (e: any) {
    if (e instanceof SimplefinError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Paste a SimpleFIN setup token" }, { status: 400 });
    // Unexpected (database, etc.) — log it and show the reason, since a
    // generic message leaves no way to tell what went wrong.
    console.error("SimpleFIN connect failed", e);
    const detail = String(e?.message ?? e).split("\n").filter(Boolean).pop()?.slice(0, 200);
    return NextResponse.json({ error: `Failed to connect SimpleFIN: ${detail}` }, { status: 500 });
  }
}
