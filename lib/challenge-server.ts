import { prisma } from "./prisma";
import { planChallenge, clampPayDay, type ChallengeDebt, type ChallengeResult, type Strategy } from "./debt-challenge";

// Every debt's current balance, worked out the same way the dashboard does:
// the starting amount plus charges minus payments (bank-synced cards and
// loans keep theirs current through those debt payments).
export async function loadChallengeDebts(userId: string): Promise<ChallengeDebt[]> {
  const debts = await prisma.entry.findMany({
    where: { userId, type: "debt" },
    include: { debtPayments: { select: { amount: true, kind: true } } },
  });
  return debts.map((d) => {
    const charged = d.debtPayments.reduce((s, p) => s + (p.kind === "charge" ? p.amount : 0), 0);
    const paid = d.debtPayments.reduce((s, p) => s + (p.kind === "charge" ? 0 : p.amount), 0);
    return {
      id: d.id,
      label: d.label,
      balance: Math.max(0, d.amount + charged - paid),
      apr: d.apr,
      minPayment: d.minPayment,
    };
  });
}

export async function challengeStatus(
  userId: string,
  today: string
): Promise<{ challenge: { monthlyAmount: number; strategy: Strategy; payDay: number; startDebt: number; targetDate: string | null; startedAt: Date } | null; result: ChallengeResult | null }> {
  const challenge = await prisma.debtChallenge.findUnique({ where: { userId } });
  if (!challenge) return { challenge: null, result: null };
  const settings = {
    monthlyAmount: challenge.monthlyAmount,
    strategy: (challenge.strategy === "snowball" ? "snowball" : "avalanche") as Strategy,
    payDay: clampPayDay(challenge.payDay),
    startDebt: challenge.startDebt,
    targetDate: challenge.targetDate,
  };
  const result = planChallenge(await loadChallengeDebts(userId), settings, today);
  return { challenge: { ...settings, startedAt: challenge.startedAt }, result };
}
