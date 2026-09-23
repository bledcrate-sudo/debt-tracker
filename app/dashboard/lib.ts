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

// Live total of connected chequing/savings accounts (see lib/bank-balance.ts).
export type BankBalance = { balance: number; asOf: string | null; accounts: number };

// With banks connected, Balance must be the real money in the accounts, not
// a figure computed from entries. The ledger still computes each month's
// flows from entries; this shifts every month by one offset so the current
// month closes exactly at the bank balance. Past months then read as that
// real balance worked backwards through the recorded flows.
export function anchorLedger<T extends { month: string; carryIn: number; closing: number; available: number }>(
  rows: T[],
  month: string,
  actual: number
): T[] {
  const row = rows.find((r) => r.month === month) ?? rows[rows.length - 1];
  if (!row) return rows;
  const offset = actual - row.closing;
  return rows.map((r) => ({
    ...r,
    carryIn: r.carryIn + offset,
    closing: r.closing + offset,
    available: r.available + offset,
  }));
}

// ---- Budget --------------------------------------------------------------

export type BudgetItem = { id: string; label: string; amount: number; keywords: string | null };

export type BudgetLine = {
  kind: "bill" | "debt" | "essential";
  id: string;
  label: string;
  need: number; // what this line takes this month
  paid: boolean; // bill paid / debt payment made this cycle
  funded: number; // covered by this month's pay so far
  short: number; // still uncovered
  dueDay?: number | null;
  spent?: number; // essentials: matching purchases this month
  noMinimum?: boolean; // debt with no minimum payment set
};

export type BudgetPlan = {
  income: number;
  lines: BudgetLine[];
  totalNeed: number;
  covered: number;
  leftover: number; // pay left after every line is covered
  extraToDebt: number;
  extraTarget: { id: string; label: string } | null;
  freeToSpend: number;
};

// Case-insensitive "any keyword appears in the description".
export function matchesKeywords(label: string, keywords: string | null): boolean {
  const words = (keywords ?? "")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  const l = label.toLowerCase();
  return words.some((w) => l.includes(w));
}

const cents = (n: number) => Math.round(n * 100) / 100;

// Splits the month's pay in priority order — bills, then debt minimums, then
// essentials — so each line shows whether it's covered yet; with more than
// one paycheque, later lines fill in as pay arrives. Whatever's left once
// everything is covered is split between an extra payment on the priority
// debt (debtSharePct) and money that's free to spend.
export function planBudget(input: {
  income: number;
  bills: { id: string; label: string; amount: number; paid: boolean }[];
  debts: { id: string; label: string; balance: number; minPayment: number | null; dueDay: number | null; paid: boolean }[];
  essentials: { id: string; label: string; amount: number; spent: number }[];
  debtSharePct: number;
  // The debt to put extra on (the payoff plan's "attack first").
  target: { id: string; label: string; balance: number } | null;
}): BudgetPlan {
  const lines: BudgetLine[] = [
    ...input.bills.map((b) => ({ kind: "bill" as const, id: b.id, label: b.label, need: cents(b.amount), paid: b.paid, funded: 0, short: 0 })),
    ...input.debts
      .filter((d) => d.balance > 0.005)
      .map((d) => ({
        kind: "debt" as const,
        id: d.id,
        label: d.label,
        // Never more than what's left owing.
        need: cents(Math.min(d.minPayment ?? 0, d.balance)),
        paid: d.paid,
        funded: 0,
        short: 0,
        dueDay: d.dueDay,
        noMinimum: !d.minPayment,
      })),
    ...input.essentials.map((e) => ({
      kind: "essential" as const,
      id: e.id,
      label: e.label,
      need: cents(e.amount),
      paid: false,
      funded: 0,
      short: 0,
      spent: cents(e.spent),
    })),
  ];

  let remaining = Math.max(0, input.income);
  for (const line of lines) {
    line.funded = cents(Math.min(line.need, remaining));
    line.short = cents(line.need - line.funded);
    remaining = cents(remaining - line.funded);
  }

  const totalNeed = cents(lines.reduce((s, l) => s + l.need, 0));
  const covered = cents(lines.reduce((s, l) => s + l.funded, 0));
  const leftover = remaining;
  const target = input.target && input.target.balance > 0.005 ? input.target : null;
  // Don't suggest paying more than the target still owes after its minimum.
  const targetMin = target ? lines.find((l) => l.kind === "debt" && l.id === target.id)?.need ?? 0 : 0;
  const pct = Math.min(100, Math.max(0, input.debtSharePct));
  const extraToDebt = target ? cents(Math.min(leftover * (pct / 100), Math.max(0, target.balance - targetMin))) : 0;

  return {
    income: cents(input.income),
    lines,
    totalNeed,
    covered,
    leftover,
    extraToDebt,
    extraTarget: target ? { id: target.id, label: target.label } : null,
    freeToSpend: cents(leftover - extraToDebt),
  };
}

// ---- Should I buy it? ------------------------------------------------------

// Next payday from past pay dates: last pay + the typical gap between pays
// (median, so one odd deposit doesn't skew it). Null without a pattern.
export function nextPayDate(payDates: Date[], today = new Date()): Date | null {
  const days = [...new Set(payDates.map((d) => Math.floor(d.getTime() / 86400_000)))].sort((a, b) => a - b);
  if (days.length < 2) return null;
  const gaps = days
    .slice(1)
    .map((d, i) => d - days[i])
    .filter((g) => g >= 7 && g <= 35) // ignore same-week bonuses and long breaks
    .sort((a, b) => a - b);
  if (gaps.length === 0) return null;
  const gap = gaps[Math.floor(gaps.length / 2)];
  const todayDay = Math.floor(today.getTime() / 86400_000);
  let next = days[days.length - 1] + gap;
  while (next < todayDay) next += gap;
  return new Date(next * 86400_000 + 12 * 3600_000);
}

export type BuyAdvice = {
  verdict: "yes" | "wait" | "no";
  headline: string;
  reasons: string[];
};

// Whether buying something for `price` right now fits the user's money:
// "yes" when it fits in this month's free-to-spend and every need is still
// covered; "wait" when it would eat the extra debt payment or needs saving
// first; "no" when it would leave this month's needs short or would take
// over a year to save for.
export function shouldBuy(
  input: {
    price: number;
    freeToSpend: number; // this month, after needs and the extra debt payment
    extraToDebt: number; // this month's planned extra debt payment
    extraTarget: string | null;
    cash: number; // money in the bank now
    upcomingNeeds: number; // still to go out this month for bills, minimums, essentials
    monthlyFree: number; // typical free-to-spend in a month
    nextPay: Date | null;
    debtCost: { months: number; interest: number } | null; // if this money doesn't go to debt
  },
  fmt: Formatter,
  today = new Date()
): BuyAdvice {
  const { price } = input;
  const free = Math.max(0, input.freeToSpend);
  const cashAfter = input.cash - price - input.upcomingNeeds;
  const date = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const debtNote =
    input.debtCost && (input.debtCost.months > 0 || input.debtCost.interest >= 1)
      ? `Put toward debt instead, it would make you debt-free ${
          input.debtCost.months > 0 ? `${input.debtCost.months} month${input.debtCost.months === 1 ? "" : "s"} sooner` : "sooner"
        } and save about ${fmt(input.debtCost.interest)} in interest.`
      : null;
  const saveFor = (amount: number) => {
    if (input.monthlyFree <= 0) return null;
    const months = Math.ceil(amount / input.monthlyFree);
    const by = new Date(today.getFullYear(), today.getMonth() + months, 1);
    return { months, label: by.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
  };
  const nextPay = input.nextPay ? `Your next pay should land around ${date(input.nextPay)}.` : null;

  if (cashAfter < 0) {
    const plan = saveFor(price);
    return {
      verdict: "no",
      headline: "Not now — you'd come up short this month.",
      reasons: [
        `After buying it you'd be ${fmt(-cashAfter)} short of what your bills, debt minimums and essentials still need this month.`,
        plan && plan.months <= 12
          ? `Setting aside your free money, you could afford it around ${plan.label}.`
          : input.monthlyFree > 0
          ? `At about ${fmt(input.monthlyFree)} free a month, it would take over a year to save for.`
          : "Your pay doesn't leave anything free after needs and debt payments yet.",
        ...(nextPay ? [nextPay] : []),
      ],
    };
  }

  if (price <= free) {
    return {
      verdict: "yes",
      headline: "Yes — it fits in this month's free money.",
      reasons: [
        `You'd still have ${fmt(free - price)} free to spend this month, with every bill and minimum covered.`,
        ...(debtNote ? [debtNote] : []),
      ],
    };
  }

  if (price <= free + input.extraToDebt) {
    return {
      verdict: "wait",
      headline: "Only by skipping your extra debt payment — better to wait.",
      reasons: [
        `You have ${fmt(free)} free; the other ${fmt(price - free)} would come out of this month's extra payment${
          input.extraTarget ? ` on ${input.extraTarget}` : ""
        }.`,
        ...(debtNote ? [debtNote] : []),
        ...(nextPay ? [nextPay] : []),
      ],
    };
  }

  const plan = saveFor(price - free);
  if (!plan || plan.months > 12) {
    return {
      verdict: "no",
      headline: "Not realistic right now.",
      reasons: [
        input.monthlyFree > 0
          ? `At about ${fmt(input.monthlyFree)} free a month, it would take over a year to save for.`
          : "Your pay doesn't leave anything free after needs and debt payments yet.",
        ...(debtNote ? [debtNote] : []),
      ],
    };
  }
  return {
    verdict: "wait",
    headline: `Wait — save for it${plan.months <= 1 ? " until next month" : ` for about ${plan.months} months`}.`,
    reasons: [
      `It's ${fmt(price - free)} more than you have free this month.`,
      `At about ${fmt(input.monthlyFree)} free a month, you'd have it by ${plan.label}.`,
      ...(debtNote ? [debtNote] : []),
    ],
  };
}
