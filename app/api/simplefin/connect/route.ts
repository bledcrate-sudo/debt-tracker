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
    const message = e instanceof SimplefinError || e instanceof z.ZodError ? e.message : "Failed to connect SimpleFIN";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
