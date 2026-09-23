import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { syncPlaidItem } from "@/lib/plaid-sync";

const schema = z.object({ itemId: z.string().optional() });

// Re-pulls balances/liabilities/transactions for one linked bank, or every
// bank the user has connected when no itemId is given (the "Sync now" button
// with nothing selected, or a background refresh).
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { itemId } = schema.parse(await req.json().catch(() => ({})));

  const items = await prisma.plaidItem.findMany({
    where: { userId, ...(itemId ? { id: itemId } : {}) },
  });
  if (itemId && items.length === 0)
    return NextResponse.json({ error: "Bank not found" }, { status: 404 });

  const results: Record<string, unknown> = {};
  for (const item of items) {
    try {
      results[item.id] = await syncPlaidItem(item.id, userId);
      await prisma.plaidItem.update({ where: { id: item.id }, data: { status: "active", error: null } });
    } catch (e: any) {
      const message = e?.response?.data?.error_message ?? e?.message ?? "Sync failed";
      results[item.id] = { error: message };
      await prisma.plaidItem.update({ where: { id: item.id }, data: { status: "error", error: message } });
    }
  }
  return NextResponse.json({ results });
}
