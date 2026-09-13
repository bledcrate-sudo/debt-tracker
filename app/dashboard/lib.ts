// Pure, framework-free logic for the dashboard: types, formatting, date math,
// the payoff simulation, and the suggestion engine. Kept separate from
// Dashboard.tsx so it can be unit tested without React.

export type EntryType = "income" | "expense" | "purchase" | "debt";
export type PaySource = "balance" | "off" | "debt";

export type Entry = {
  id: string;
  type: string;
  label: string;
  amount: number;
  frequency: string;
  apr?: number | null;
  minPayment?: number | null;
  dueDay?: number | null;
  sourceKind?: string | null;
  debtEntryId?: string | null;
  note: string | null;
  createdAt: string;
  payments: { month: string; fromBalance: boolean; debtEntryId?: string | null }[];
  debtPayments: { id: string; amount: number; kind: string; fromBalance: boolean; note: string | null; paidAt: string }[];
  originalAmount?: number;
  paidSoFar?: number;
  chargedSoFar?: number;
};

export type Formatter = (n: number) => string;

export const makeFmt = (currency: string): Formatter => (n: number) => {
  try {
    return n.toLocaleString(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }
};

export const CURRENCY_FALLBACK = [
  "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "BRL",
  "MXN", "ZAR", "SEK", "NOK", "DKK", "PLN", "TRY", "RUB", "KRW", "SGD",
  "HKD", "NZD", "AED", "SAR", "EGP", "NGN", "KES", "MAD", "TND", "DZD",
  "ILS", "THB", "IDR", "MYR", "PHP", "VND", "PKR", "BDT", "LKR", "CZK",
  "HUF", "RON", "UAH", "CLP", "COP", "ARS", "PEN", "TWD", "QAR", "KWD",
];

export const allCurrencies = (): string[] => {
  const supported = (Intl as any).supportedValuesOf;
  if (typeof supported === "function") {
    try {
      return supported.call(Intl, "currency") as string[];
    } catch {
      /* fall through */
    }
  }
  return CURRENCY_FALLBACK;
};

export const currencyName = (code: string) => {
  try {
    const dn = new Intl.DisplayNames(undefined, { type: "currency" });
    return dn.of(code) ?? code;
  } catch {
    return code;
  }
};

export const currencySymbol = (code: string) => {
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
};

export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

export const shiftMonth = (key: string, delta: number) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
};

export const monthDisplay = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

// Bills due "on the 31st" land on a month's last day when it's shorter, so
// clamp the configured day to whatever month it actually falls in.
export const daysUntilDue = (dueDay: number, now = new Date()) => {
  const today = now.getDate();
  const thisMonthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dueThisMonth = Math.min(dueDay, thisMonthDays);
  if (dueThisMonth >= today) return dueThisMonth - today;
  const nextMonthDays = new Date(now.getFullYear(), now.getMonth() + 2, 0).getDate();
  return thisMonthDays - today + Math.min(dueDay, nextMonthDays);
};

// Clears the reminder once a payment has been logged for the due day's
// current cycle, instead of it lingering until the due date itself passes.
export const paidSinceLastDue = (
  dueDay: number,
  payments: { kind: string; paidAt: string }[],
  now = new Date()
) => {
  const thisMonthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dueThisMonth = new Date(now.getFullYear(), now.getMonth(), Math.min(dueDay, thisMonthDays));
  let lastDue = dueThisMonth;
  if (dueThisMonth > now) {
    const prevMonthDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    lastDue = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(dueDay, prevMonthDays));
  }
  return payments.some((p) => p.kind === "payment" && new Date(p.paidAt) >= lastDue);
};

export const bornIn = (e: { createdAt: string }) => monthKey(new Date(e.createdAt));
export const activeIn = (e: { createdAt: string; frequency: string }, month: string) =>
  e.frequency === "monthly" ? bornIn(e) <= month : bornIn(e) === month;

export type SimDebt = Entry & { originalAmount?: number; paidSoFar?: number; chargedSoFar?: number };

// Amortization simulation: minimums on every debt, extra rolls into the
// target debt, freed minimums snowball forward, interest accrues monthly.
export function simulatePayoff(debts: SimDebt[], strategy: "avalanche" | "snowball", extraPerMonth: number) {
  const MAX_MONTHS = 600;
  const order = [...debts].filter((d) => d.amount > 0);
  if (strategy === "avalanche")
    order.sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0) || b.amount - a.amount);
  else order.sort((a, b) => a.amount - b.amount);

  const sim = order.map((d) => ({
    id: d.id,
    balance: d.amount,
    apr: d.apr ?? 0,
    min: d.minPayment ?? 0,
    eta: Infinity as number,
    interest: 0,
  }));
  const totalMin = sim.reduce((s, d) => s + d.min, 0);
  const timeline: number[] = [sim.reduce((s, d) => s + d.balance, 0)];
  let totalInterest = 0;
  let month = 0;

  while (sim.some((d) => d.balance > 0.005) && month < MAX_MONTHS) {
    month++;
    let extra =
      extraPerMonth + totalMin - sim.filter((d) => d.balance > 0.005).reduce((s, d) => s + d.min, 0);
    for (const d of sim) {
      if (d.balance <= 0.005) continue;
      const i = (d.balance * d.apr) / 1200;
      d.balance += i;
      d.interest += i;
      totalInterest += i;
    }
    for (const d of sim) {
      if (d.balance <= 0.005) continue;
      const pay = Math.min(d.min, d.balance);
      d.balance -= pay;
      if (d.balance <= 0.005 && d.eta === Infinity) d.eta = month;
    }
    for (const d of sim) {
      if (extra <= 0) break;
      if (d.balance <= 0.005) continue;
      const pay = Math.min(extra, d.balance);
      d.balance -= pay;
      extra -= pay;
      if (d.balance <= 0.005 && d.eta === Infinity) d.eta = month;
    }
    timeline.push(sim.reduce((s, d) => s + d.balance, 0));
    if (extraPerMonth + totalMin <= 0) break; // nothing being paid at all
  }

  const done = sim.every((d) => d.balance <= 0.005);
  const byId = new Map(sim.map((d) => [d.id, d]));
  return {
    order: order.map((d) => {
      const s = byId.get(d.id)!;
      return { ...d, months: s.eta, eta: s.eta, interest: s.interest };
    }),
    monthsToClear:
      done && month > 0
        ? Math.max(...sim.map((d) => (d.eta === Infinity ? 0 : d.eta)), 0) || Infinity
        : Infinity,
    totalInterest: done ? totalInterest : Infinity,
    timeline,
  };
}

export function monthLabel(monthsFromNow: number) {
  const d = new Date();
  d.setMonth(d.getMonth() + monthsFromNow);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export type Suggestion = { title: string; body: string; tone: "good" | "warn" | "bad" };

export function buildSuggestions(ctx: {
  fmt: Formatter;
  totalIncome: number;
  expectedIncome: number;
  totalExpense: number;
  totalDebt: number;
  surplus: number;
  dti: number;
  monthsToClear: number;
  debtCount: number;
  biggestDebt: Entry | null;
  smallestDebt: Entry | null;
}): Suggestion[] {
  const { fmt } = ctx;
  const out: Suggestion[] = [];

  if (ctx.expectedIncome === 0) {
    out.push({
      title: "Add your income first",
      body: "Log at least one income source so the planner can size your monthly contribution.",
      tone: "warn",
    });
    return out;
  }

  if (ctx.surplus <= 0) {
    out.push({
      title: "You're spending more than you earn",
      body: `Expenses exceed income by ${fmt(-ctx.surplus)}. Cut discretionary expenses before attacking debt — interest will outpace any progress.`,
      tone: "bad",
    });
  } else {
    out.push({
      title: `Free cash flow: ${fmt(ctx.surplus)} / mo`,
      body: `Strong base — apply at least 50% (${fmt(ctx.surplus * 0.5)}) to debt and the rest to savings/emergency fund.`,
      tone: "good",
    });
  }

  if (ctx.dti > 0.4) {
    out.push({
      title: `High debt-to-income (${pct(ctx.dti)})`,
      body: "Above 40% is risky. Avoid taking on new credit. Consider consolidating high-interest debts into one lower-rate loan.",
      tone: "bad",
    });
  } else if (ctx.dti > 0.2) {
    out.push({
      title: `Moderate DTI (${pct(ctx.dti)})`,
      body: "Manageable but worth tightening. Snowball small debts first for quick wins, then pivot to avalanche.",
      tone: "warn",
    });
  } else if (ctx.totalDebt > 0) {
    out.push({
      title: `Healthy DTI (${pct(ctx.dti)})`,
      body: "You're in good shape. Stay consistent and you'll be debt-free fast.",
      tone: "good",
    });
  }

  if (ctx.biggestDebt && ctx.debtCount > 1) {
    out.push({
      title: `Avalanche target: ${ctx.biggestDebt.label}`,
      body: `Largest balance at ${fmt(ctx.biggestDebt.amount)}. Throw extra payments here to kill the highest interest cost (assuming it's also the highest rate).`,
      tone: "warn",
    });
  }
  if (ctx.smallestDebt && ctx.debtCount > 1 && ctx.smallestDebt.id !== ctx.biggestDebt?.id) {
    out.push({
      title: `Snowball quick win: ${ctx.smallestDebt.label}`,
      body: `Only ${fmt(ctx.smallestDebt.amount)} left. Clearing this first gives momentum and frees its minimum payment for the next debt.`,
      tone: "good",
    });
  }

  if (ctx.totalDebt > 0 && ctx.monthsToClear !== Infinity) {
    const years = (ctx.monthsToClear / 12).toFixed(1);
    out.push({
      title: `Debt-free in ~${ctx.monthsToClear} months`,
      body: `At your current contribution rate, you'll clear all debt in roughly ${years} years. Bump the slider to model faster payoff.`,
      tone: "good",
    });
  }

  if (ctx.totalDebt === 0 && ctx.totalIncome > 0) {
    out.push({
      title: "No debt logged — nice.",
      body: "Redirect that surplus into an emergency fund (3–6 months of expenses), then index funds.",
      tone: "good",
    });
  }

  return out;
}
