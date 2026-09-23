import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

// Never returns accessToken — this is what the client uses to render the
// "connected banks" list, so it only needs display fields.
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const items = await prisma.plaidItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      institutionName: true,
      status: true,
      error: true,
      createdAt: true,
      accounts: {
        select: {
          id: true,
          name: true,
          mask: true,
          type: true,
          subtype: true,
          lastBalance: true,
          lastSyncedAt: true,
          entryId: true,
        },
      },
    },
  });
  return NextResponse.json(items);
}
