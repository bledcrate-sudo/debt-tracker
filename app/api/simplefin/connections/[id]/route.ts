import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

// Removes the stored Access URL. SimpleFIN has no revoke endpoint, so the
// user disables the app on SimpleFIN Bridge themselves. Debts it created stay
// as ordinary manually-tracked entries.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conn = await prisma.simplefinConnection.findUnique({ where: { id: params.id } });
  if (!conn || conn.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.simplefinConnection.delete({ where: { id: conn.id } });
  return NextResponse.json({ ok: true });
}
