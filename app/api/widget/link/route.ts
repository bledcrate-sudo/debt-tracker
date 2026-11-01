import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { normalizeCode } from "@/lib/widget-auth";

// Links a home-screen widget to the signed-in account with the 6-digit code
// the widget is showing.
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const code = normalizeCode(String(body?.code ?? ""));
  if (!code) return NextResponse.json({ error: "Enter the 6-digit code the widget shows" }, { status: 400 });

  const device = await prisma.widgetDevice.findFirst({
    where: { pairCode: code, pairCodeExpiresAt: { gt: new Date() }, userId: null },
  });
  if (!device) {
    return NextResponse.json(
      { error: "That code didn't match a widget. Check the code on the widget (it changes every 30 minutes) and try again." },
      { status: 404 }
    );
  }
  await prisma.widgetDevice.update({
    where: { id: device.id },
    data: { userId, pairCode: null, pairCodeExpiresAt: null, linkedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
