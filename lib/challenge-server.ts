import { prisma } from "./prisma";
import {
  planChallenge,
  clampPayDay,
  challengeDebtList,
  type ChallengeDebt,
  type ChallengePayment,
  type ChallengeResult,
  type DebtSource,
  type Strategy,
} from "./debt-challenge";

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

export type ChallengeView = {
  monthlyAmount: number;
  strategy: Strategy;
  payDay: number;
  startDebt: number;
  targetDate: string | null;
  debtSource: DebtSource;
  manualDebt: number | null;
  manualApr: number | null;
  startedAt: Date;
};

export async function challengeStatus(
  userId: string,
  today: string
): Promise<{ challenge: ChallengeView | null; payments: ChallengePayment[]; result: ChallengeResult | null }> {
  const challenge = await prisma.debtChallenge.findUnique({ where: { userId } });
  if (!challenge) return { challenge: null, payments: [], result: null };
  const view: ChallengeView = {
    monthlyAmount: challenge.monthlyAmount,
    strategy: challenge.strategy === "snowball" ? "snowball" : "avalanche",
    payDay: clampPayDay(challenge.payDay),
    startDebt: challenge.startDebt,
    targetDate: challenge.targetDate,
    debtSource: challenge.debtSource === "manual" ? "manual" : "accounts",
    manualDebt: challenge.manualDebt,
    manualApr: challenge.manualApr,
    startedAt: challenge.startedAt,
  };
  const payments =
    view.debtSource === "manual"
      ? await prisma.challengePayment.findMany({
          where: { userId },
          select: { id: true, amount: true, paidAt: true },
          orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
        })
      : [];
  const debts = challengeDebtList(view.debtSource, view.debtSource === "manual" ? [] : await loadChallengeDebts(userId), {
    amount: view.manualDebt,
    apr: view.manualApr,
    payments,
  });
  return { challenge: view, payments, result: planChallenge(debts, view, today) };
}
