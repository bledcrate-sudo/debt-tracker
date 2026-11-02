// The debt-free challenge: commit a total monthly amount toward all debts,
// get the date the last one is paid off and a day-by-day countdown to it.
// Pure date/plan math shared by the dashboard, the challenge API and the
// home-screen widget's API, so all three always show the same number.
//
// Dates are calendar dates ("YYYY-MM-DD"), handled as UTC midnights so the
// math never shifts with the server's or the phone's timezone; callers pass
// "today" in the user's own timezone.
import { simulatePayoff, type SimDebt } from "../app/dashboard/lib";

export type Strategy = "avalanche" | "snowball";

export type ChallengeDebt = {
  id: string;
  label: string;
  balance: number;
  apr: number | null;
  minPayment: number | null;
};

// Where the challenge's debt comes from: the user's accounts (entries and
// bank sync), or one balance they set themselves and pay down by logging
// payments in the challenge.
export type DebtSource = "accounts" | "manual";
export type ChallengePayment = { id: string; amount: number; paidAt: string };

export function challengeDebtList(
  source: DebtSource,
  accountDebts: ChallengeDebt[],
  manual: { amount: number | null; apr: number | null; payments: { amount: number }[] }
): ChallengeDebt[] {
  if (source !== "manual") return accountDebts;
  const paid = manual.payments.reduce((s, p) => s + p.amount, 0);
  return [{ id: "manual", label: "My debt", balance: Math.max(0, (manual.amount ?? 0) - paid), apr: manual.apr, minPayment: null }];
}

// Balance-weighted average APR, to suggest one when switching to a debt
// the user sets themselves.
export function weightedApr(debts: ChallengeDebt[]): number | null {
  const withApr = debts.filter((d) => d.balance > 0 && d.apr != null);
  const total = withApr.reduce((s, d) => s + d.balance, 0);
  if (total <= 0) return null;
  return Math.round((withApr.reduce((s, d) => s + d.balance * (d.apr ?? 0), 0) / total) * 100) / 100;
}

export type ChallengeSettings = {
  monthlyAmount: number;
  strategy: Strategy;
  payDay: number; // day of the month the payment goes out, 1–28
  startDebt: number; // total owed when the challenge started
  targetDate: string | null; // the debt-free date promised at the start (or at the last change of plan)
};

export type ChallengeResult = {
  totalDebt: number;
  totalMin: number;
  belowMinimums: boolean; // the monthly amount doesn't even cover the minimums
  monthsLeft: number | null; // payments left; null = never at this amount
  nextPaymentDate: string;
  debtFreeDate: string | null;
  daysLeft: number | null;
  paidOff: number; // since the start
  progress: number; // share of the starting debt paid off, 0–1
  totalInterest: number | null;
  daysAhead: number | null; // vs targetDate: > 0 ahead of schedule, < 0 behind
  done: boolean; // nothing left to pay
  order: { id: string; label: string; balance: number; apr: number | null; payoffDate: string | null }[];
};

const DAY = 86400_000;

export function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Today's date in the given timezone (defaults to the runtime's own).
export function todayIn(timeZone?: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export const clampPayDay = (n: number) => Math.min(28, Math.max(1, Math.round(n) || 1));

function addMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY);
}

// The next payment on/after today, on the chosen day of the month.
export function nextPaymentDate(today: string, payDay: number): string {
  const t = parseDay(today);
  const day = clampPayDay(payDay);
  const thisMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), day));
  return formatDay(t.getUTCDate() <= day ? thisMonth : addMonths(thisMonth, 1));
}

export function planChallenge(debts: ChallengeDebt[], settings: ChallengeSettings, today: string): ChallengeResult {
  const open = debts.filter((d) => d.balance > 0.005);
  const totalDebt = open.reduce((s, d) => s + d.balance, 0);
  const totalMin = open.reduce((s, d) => s + (d.minPayment ?? 0), 0);
  const next = nextPaymentDate(today, settings.payDay);
  const paidOff = Math.max(0, settings.startDebt - totalDebt);
  const progress = settings.startDebt > 0 ? Math.min(1, paidOff / settings.startDebt) : totalDebt > 0 ? 0 : 1;

  if (open.length === 0) {
    return {
      totalDebt: 0,
      totalMin: 0,
      belowMinimums: false,
      monthsLeft: 0,
      nextPaymentDate: next,
      debtFreeDate: today,
      daysLeft: 0,
      paidOff,
      progress: 1,
      totalInterest: 0,
      daysAhead: settings.targetDate ? daysBetween(today, settings.targetDate) : null,
      done: true,
      order: [],
    };
  }

  // simulatePayoff pays every minimum, then spreads the extra; the
  // commitment is the total, so the extra is what's left over the minimums.
  const extra = Math.max(0, settings.monthlyAmount - totalMin);
  const sim = simulatePayoff(
    open.map((d) => ({ id: d.id, label: d.label, amount: d.balance, apr: d.apr, minPayment: d.minPayment }) as SimDebt),
    settings.strategy,
    extra
  );
  const monthsLeft = Number.isFinite(sim.monthsToClear) ? sim.monthsToClear : null;
  // Payment n lands on the nth payment date from the next one, so the date
  // only moves when a payment is made (or the balance changes), and the
  // countdown drops by one every day in between.
  const paymentDate = (n: number) => formatDay(addMonths(parseDay(next), n - 1));
  const debtFreeDate = monthsLeft === null ? null : paymentDate(monthsLeft);

  return {
    totalDebt,
    totalMin,
    belowMinimums: settings.monthlyAmount + 0.005 < totalMin,
    monthsLeft,
    nextPaymentDate: next,
    debtFreeDate,
    daysLeft: debtFreeDate ? daysBetween(today, debtFreeDate) : null,
    paidOff,
    progress,
    totalInterest: Number.isFinite(sim.totalInterest) ? sim.totalInterest : null,
    daysAhead: debtFreeDate && settings.targetDate ? daysBetween(debtFreeDate, settings.targetDate) : null,
    done: false,
    order: sim.order.map((d) => ({
      id: d.id,
      label: d.label,
      balance: d.amount,
      apr: d.apr ?? null,
      payoffDate: Number.isFinite(d.eta) ? paymentDate(d.eta) : null,
    })),
  };
}
