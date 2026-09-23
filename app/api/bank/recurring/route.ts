import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { detectRecurring } from "@/lib/recurring";

// Subscriptions and other recurring charges, spotted in the last year of
// imported purchases. Recomputed on each call — there's little enough data
// per user that storing it separately isn't worth the staleness risk.
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date(Date.now() - 370 * 86400_000);
  const rows = await prisma.bankTransaction.findMany({
    where: { userId, kind: "purchase", date: { gte: since } },
    select: { description: true, amount: true, date: true },
    orderBy: { date: "asc" },
  });
  const charges = detectRecurring(rows.map((r) => ({ label: r.description, amount: r.amount, date: r.date })));
  return NextResponse.json(charges);
}
