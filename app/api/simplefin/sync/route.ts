import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { syncSimplefinConnection } from "@/lib/simplefin";

// force skips the cooldown — the UI sends it right after an account's kind
// changes, so the change shows up without waiting.
const schema = z.object({ connectionId: z.string().optional(), force: z.boolean().optional() });

// Syncs one SimpleFIN connection, or all of the user's when none is given.
// Connections synced within the cooldown are skipped (SimpleFIN allows ~24
// requests a day and only refreshes bank data daily).
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { connectionId, force } = schema.parse(await req.json().catch(() => ({})));
  const conns = await prisma.simplefinConnection.findMany({
    where: { userId, ...(connectionId ? { id: connectionId } : {}) },
  });
  if (connectionId && conns.length === 0)
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });

  const results: Record<string, unknown> = {};
  for (const conn of conns) {
    try {
      results[conn.id] = await syncSimplefinConnection(conn.id, userId, { force: force && !!connectionId });
    } catch (e: any) {
      const message = e?.message ?? "Sync failed";
      results[conn.id] = { error: message };
      await prisma.simplefinConnection.update({
        where: { id: conn.id },
        data: { status: "error", error: message },
      });
    }
  }
  return NextResponse.json({ results });
}
