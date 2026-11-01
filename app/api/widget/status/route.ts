import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { bearerKey, widgetDevice } from "@/lib/widget-auth";
import { challengeStatus } from "@/lib/challenge-server";
import { todayIn } from "@/lib/debt-challenge";

export const dynamic = "force-dynamic";

// What the iPhone home-screen widget shows. Authenticated by the widget's
// own key (see lib/widget-auth.ts), not a login session. Unlinked: the
// pairing code to type into the app. Linked: just the countdown numbers.
// Body (optional): { "today": "YYYY-MM-DD" } — the phone's date.
export async function POST(req: Request) {
  const key = bearerKey(req);
  if (!key) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const today = typeof body?.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : todayIn();

  const device = await widgetDevice(key);
  if (!device.userId) {
    return NextResponse.json({ paired: false, code: device.pairCode });
  }
  await prisma.widgetDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

  const user = await prisma.user.findUnique({ where: { id: device.userId }, select: { currency: true } });
  const { challenge, result } = await challengeStatus(device.userId, today);
  if (!challenge || !result) {
    return NextResponse.json({ paired: true, active: false, currency: user?.currency ?? "CAD" });
  }
  return NextResponse.json({
    paired: true,
    active: true,
    currency: user?.currency ?? "CAD",
    debtFreeDate: result.debtFreeDate,
    daysLeft: result.daysLeft,
    totalDebt: Math.round(result.totalDebt * 100) / 100,
    startDebt: challenge.startDebt,
    progress: result.progress,
    monthly: challenge.monthlyAmount,
    daysAhead: result.daysAhead,
    done: result.done,
  });
}
