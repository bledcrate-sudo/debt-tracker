import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

// The merged feed: every imported transaction from every connected bank for
// one month (?month=YYYY-MM), newest first. Transactions are stored at noon
// UTC of their day, so UTC month bounds bucket them correctly.
export async function GET(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const month = new URL(req.url).searchParams.get("month") ?? "";
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
  const from = new Date(Date.UTC(+m[1], +m[2] - 1, 1));
  const to = new Date(Date.UTC(+m[1], +m[2], 1));

  const rows = await prisma.bankTransaction.findMany({
    where: { userId, date: { gte: from, lt: to } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: { id: true, institution: true, account: true, date: true, amount: true, description: true, kind: true },
  });
  return NextResponse.json(rows);
}
