import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

// The widgets linked to this account, and unlinking one (?id=).
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const devices = await prisma.widgetDevice.findMany({
    where: { userId },
    select: { id: true, linkedAt: true, lastSeenAt: true },
    orderBy: { linkedAt: "asc" },
  });
  return NextResponse.json(devices);
}

export async function DELETE(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  await prisma.widgetDevice.deleteMany({ where: { id, userId } });
  return NextResponse.json({ ok: true });
}
