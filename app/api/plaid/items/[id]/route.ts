import { NextResponse } from "next/server";
import { plaidClient } from "@/lib/plaid";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { decryptToken } from "@/lib/plaid-crypto";

// Unlinks a bank. The debt Entries it created stay — they're now just
// ordinary manually-tracked debts, same as anything typed in by hand.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const item = await prisma.plaidItem.findUnique({ where: { id: params.id } });
  if (!item || item.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await plaidClient.itemRemove({ access_token: decryptToken(item.accessToken) });
  } catch {
    // Already revoked/invalid on Plaid's side — fine, still remove it locally.
  }
  await prisma.plaidItem.delete({ where: { id: item.id } });
  return NextResponse.json({ ok: true });
}
