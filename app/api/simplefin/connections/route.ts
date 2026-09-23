import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

// Display fields only — never the Access URL.
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conns = await prisma.simplefinConnection.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      error: true,
      lastSyncedAt: true,
      createdAt: true,
      accounts: {
        orderBy: { name: "asc" },
        select: { id: true, orgName: true, name: true, currency: true, kind: true, lastBalance: true, entryId: true },
      },
    },
  });
  return NextResponse.json(conns);
}
