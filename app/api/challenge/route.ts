import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { roundCents } from "@/lib/money";
import { loadChallengeDebts, challengeStatus } from "@/lib/challenge-server";
import { planChallenge, clampPayDay, todayIn } from "@/lib/debt-challenge";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const putSchema = z.object({
  monthlyAmount: z.number().finite().positive().max(1_000_000),
  strategy: z.enum(["avalanche", "snowball"]),
  payDay: z.number().int().min(1).max(28),
  today: day.optional(), // the phone's own date, so the plan uses the user's timezone
});

export async function GET(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const today = new URL(req.url).searchParams.get("today");
  const status = await challengeStatus(userId, today && day.safeParse(today).success ? today : todayIn());
  return NextResponse.json(status);
}

// Starts the challenge, or changes its plan. Starting records the total owed
// today (progress counts from there); every start or change of amount,
// strategy or pay day records the debt-free date it promises, which later
// "days ahead / behind" are measured against.
export async function PUT(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.errors[0]?.message ?? "Invalid input" }, { status: 400 });
  const { monthlyAmount, strategy, payDay, today = todayIn() } = parsed.data;

  const debts = await loadChallengeDebts(userId);
  const totalDebt = debts.reduce((s, d) => s + d.balance, 0);
  const existing = await prisma.debtChallenge.findUnique({ where: { userId } });
  const startDebt = existing?.startDebt ?? roundCents(totalDebt);
  const promised = planChallenge(
    debts,
    { monthlyAmount, strategy, payDay: clampPayDay(payDay), startDebt, targetDate: null },
    today
  ).debtFreeDate;

  const data = { monthlyAmount: roundCents(monthlyAmount), strategy, payDay: clampPayDay(payDay), targetDate: promised };
  await prisma.debtChallenge.upsert({
    where: { userId },
    create: { userId, startDebt, ...data },
    update: data,
  });
  return NextResponse.json(await challengeStatus(userId, today));
}

// Ends the challenge (starting again later counts progress from that day).
export async function DELETE() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await prisma.debtChallenge.deleteMany({ where: { userId } });
  return NextResponse.json({ ok: true });
}
