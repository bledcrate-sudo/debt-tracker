import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { roundCents } from "@/lib/money";
import { loadChallengeDebts, challengeStatus } from "@/lib/challenge-server";
import { planChallenge, clampPayDay, todayIn, challengeDebtList } from "@/lib/debt-challenge";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const putSchema = z
  .object({
    monthlyAmount: z.number().finite().positive().max(1_000_000),
    strategy: z.enum(["avalanche", "snowball"]),
    payDay: z.number().int().min(1).max(28),
    debtSource: z.enum(["accounts", "manual"]).default("accounts"),
    manualDebt: z.number().finite().min(0).max(100_000_000).nullable().optional(),
    manualApr: z.number().finite().min(0).max(100).nullable().optional(),
    today: day.optional(), // the phone's own date, so the plan uses the user's timezone
  })
  .refine((d) => d.debtSource !== "manual" || (d.manualDebt ?? 0) > 0, { message: "Enter how much you owe" });

export async function GET(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const today = new URL(req.url).searchParams.get("today");
  const status = await challengeStatus(userId, today && day.safeParse(today).success ? today : todayIn());
  return NextResponse.json(status);
}

// Starts the challenge, or changes its plan. Progress counts from the total
// owed at the start: today's total from the accounts, or — when the user
// sets their debt themselves — the amount they set (logged payments come
// off it). Every start or change records the debt-free date it promises,
// which later "days ahead / behind" are measured against.
export async function PUT(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.errors[0]?.message ?? "Invalid input" }, { status: 400 });
  const { monthlyAmount, strategy, payDay, debtSource, today = todayIn() } = parsed.data;
  const manualDebt = debtSource === "manual" ? roundCents(parsed.data.manualDebt ?? 0) : null;
  const manualApr = debtSource === "manual" ? parsed.data.manualApr ?? null : null;

  const existing = await prisma.debtChallenge.findUnique({ where: { userId } });
  const accountDebts = debtSource === "accounts" ? await loadChallengeDebts(userId) : [];
  const payments =
    debtSource === "manual" ? await prisma.challengePayment.findMany({ where: { userId }, select: { amount: true } }) : [];
  const debts = challengeDebtList(debtSource, accountDebts, { amount: manualDebt, apr: manualApr, payments });
  const startDebt =
    debtSource === "manual"
      ? manualDebt!
      : existing && existing.debtSource !== "manual"
      ? existing.startDebt
      : roundCents(accountDebts.reduce((s, d) => s + d.balance, 0));
  const promised = planChallenge(debts, { monthlyAmount, strategy, payDay: clampPayDay(payDay), startDebt, targetDate: null }, today)
    .debtFreeDate;

  const data = {
    monthlyAmount: roundCents(monthlyAmount),
    strategy,
    payDay: clampPayDay(payDay),
    targetDate: promised,
    debtSource,
    manualDebt,
    manualApr,
    startDebt,
  };
  await prisma.debtChallenge.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  return NextResponse.json(await challengeStatus(userId, today));
}

// Ends the challenge, with its logged payments (starting again later counts
// progress from that day).
export async function DELETE() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await prisma.$transaction([
    prisma.challengePayment.deleteMany({ where: { userId } }),
    prisma.debtChallenge.deleteMany({ where: { userId } }),
  ]);
  return NextResponse.json({ ok: true });
}
