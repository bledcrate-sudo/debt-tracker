import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { roundCents } from "@/lib/money";
import { challengeStatus } from "@/lib/challenge-server";
import { todayIn } from "@/lib/debt-challenge";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const postSchema = z.object({
  amount: z.number().finite().positive().max(100_000_000),
  paidAt: day.optional(),
  today: day.optional(),
});

// Logs a payment toward a debt the user set themselves; returns the updated
// challenge so the countdown refreshes right away.
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter the amount you paid" }, { status: 400 });
  const challenge = await prisma.debtChallenge.findUnique({ where: { userId }, select: { debtSource: true } });
  if (challenge?.debtSource !== "manual")
    return NextResponse.json({ error: "Set your debt yourself in the challenge to log payments here" }, { status: 400 });
  const today = parsed.data.today ?? todayIn();
  await prisma.challengePayment.create({
    data: { userId, amount: roundCents(parsed.data.amount), paidAt: parsed.data.paidAt ?? today },
  });
  return NextResponse.json(await challengeStatus(userId, today));
}

// Removes a logged payment (?id=…&today=YYYY-MM-DD).
export async function DELETE(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  await prisma.challengePayment.deleteMany({ where: { id: url.searchParams.get("id") ?? "", userId } });
  const today = url.searchParams.get("today");
  return NextResponse.json(await challengeStatus(userId, today && day.safeParse(today).success ? today : todayIn()));
}
