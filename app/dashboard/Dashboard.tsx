"use client";
import { useEffect, useMemo, useState } from "react";
import { signOut } from "next-auth/react";

type EntryType = "income" | "expense" | "purchase" | "debt";
type PaySource = "balance" | "off" | "debt";

type Entry = {
  id: string;
  type: string;
  label: string;
  amount: number;
  frequency: string;
  apr?: number | null;
  minPayment?: number | null;
  dueDay?: number | null;
  note: string | null;
  createdAt: string;
  payments: { month: string; fromBalance: boolean; debtEntryId?: string | null }[];
  debtPayments: { id: string; amount: number; kind: string; fromBalance: boolean; note: string | null; paidAt: string }[];
  originalAmount?: number;
  paidSoFar?: number;
  chargedSoFar?: number;
};

// Set once per render from the user's saved preference, so every fmt() call
// below (including the ones inside subcomponents) formats in their currency.
let activeCurrency = "USD";

const fmt = (n: number) => {
  try {
    return n.toLocaleString(undefined, {
      style: "currency",
      currency: activeCurrency,
      maximumFractionDigits: 2,
    });
  } catch {
    return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }
};

const CURRENCY_FALLBACK = [
  "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "BRL",
  "MXN", "ZAR", "SEK", "NOK", "DKK", "PLN", "TRY", "RUB", "KRW", "SGD",
  "HKD", "NZD", "AED", "SAR", "EGP", "NGN", "KES", "MAD", "TND", "DZD",
  "ILS", "THB", "IDR", "MYR", "PHP", "VND", "PKR", "BDT", "LKR", "CZK",
  "HUF", "RON", "UAH", "CLP", "COP", "ARS", "PEN", "TWD", "QAR", "KWD",
];

const allCurrencies = (): string[] => {
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

const currencyName = (code: string) => {
  try {
    const dn = new Intl.DisplayNames(undefined, { type: "currency" });
    return dn.of(code) ?? code;
  } catch {
    return code;
  }
};

const currencySymbol = (code: string) => {
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

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const shiftMonth = (key: string, delta: number) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
};

const monthDisplay = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

function useEscapeClose(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}

const daysUntilDue = (dueDay: number) => {
  const now = new Date();
  const today = now.getDate();
  if (dueDay >= today) return dueDay - today;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return daysInMonth - today + dueDay;
};

export default function Dashboard({
  initialEntries,
  userEmail,
  userName,
  userCurrency,
}: {
  initialEntries: Entry[];
  userEmail: string;
  userName: string | null;
  userCurrency: string;
}) {
  const [currency, setCurrency] = useState(userCurrency);
  const [settingsOpen, setSettingsOpen] = useState(false);
  activeCurrency = currency;

  const [entries, setEntries] = useState<Entry[]>(initialEntries);
  const [modalType, setModalType] = useState<EntryType | null>(null);
  const [busy, setBusy] = useState(false);
  const [strategy, setStrategy] = useState<"avalanche" | "snowball">("avalanche");
  const [payoutPct, setPayoutPct] = useState(50);

  const [currentMonth, setCurrentMonth] = useState(() => monthKey(new Date()));
  const startMonth = useMemo(() => {
    if (entries.length === 0) return currentMonth;
    const earliest = entries.reduce(
      (min, e) => (e.createdAt < min ? e.createdAt : min),
      entries[0].createdAt
    );
    const key = monthKey(new Date(earliest));
    return key < currentMonth ? key : currentMonth;
  }, [entries, currentMonth]);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [payBusy, setPayBusy] = useState<string | null>(null);
  const [payPrompt, setPayPrompt] = useState<{ id: string; label: string; amount: number } | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const now = monthKey(new Date());
      setCurrentMonth((prev) => {
        if (now === prev) return prev;
        setSelectedMonth((sel) => (sel === prev ? now : sel));
        return now;
      });
    }, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  async function unmarkPaid(entryId: string) {
    const wasOnCard = entries
      .find((e) => e.id === entryId)
      ?.payments.some((p) => p.month === selectedMonth && p.debtEntryId);
    setPayBusy(entryId);
    const r = await fetch(`/api/entries/${entryId}/pay`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ month: selectedMonth }),
    });
    setPayBusy(null);
    if (!r.ok) return alert("Failed to update paid status");
    // Undoing a card payment also drops the debt charge server-side.
    if (wasOnCard) return refreshEntries();
    setEntries((cur) =>
      cur.map((e) =>
        e.id !== entryId ? e : { ...e, payments: e.payments.filter((p) => p.month !== selectedMonth) }
      )
    );
  }

  async function markPaid(entryId: string, source: PaySource, debtEntryId?: string) {
    setPayPrompt(null);
    setPayBusy(entryId);
    const r = await fetch(`/api/entries/${entryId}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ month: selectedMonth, source, debtEntryId }),
    });
    setPayBusy(null);
    if (!r.ok) return alert("Failed to update paid status");
    // Charging a bill to a card creates a debt charge server-side, so pull the
    // fresh entry list rather than trying to mirror both writes by hand.
    if (source === "debt") return refreshEntries();
    setEntries((cur) =>
      cur.map((e) =>
        e.id !== entryId
          ? e
          : {
              ...e,
              payments: [
                ...e.payments.filter((p) => p.month !== selectedMonth),
                { month: selectedMonth, fromBalance: source === "balance", debtEntryId: null },
              ],
            }
      )
    );
  }

  async function refreshEntries() {
    const r = await fetch("/api/entries");
    if (!r.ok) return;
    setEntries(await r.json());
  }

  function togglePaid(entryId: string, paid: boolean, label: string, amount: number) {
    if (paid) unmarkPaid(entryId);
    else setPayPrompt({ id: entryId, label, amount });
  }

  // Income has no source question — it either landed or it didn't.
  function toggleReceived(entryId: string, received: boolean) {
    if (received) unmarkPaid(entryId);
    else markPaid(entryId, "balance");
  }

  const [debtModal, setDebtModal] = useState<{ id: string; label: string } | null>(null);
  const [debtPayBusy, setDebtPayBusy] = useState(false);

  async function logDebtPayment(
    entryId: string,
    amount: number,
    kind: "payment" | "charge",
    fromBalance: boolean,
    note?: string
  ) {
    setDebtPayBusy(true);
    const r = await fetch(`/api/entries/${entryId}/debt-payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount, kind, fromBalance, note }),
    });
    setDebtPayBusy(false);
    if (!r.ok) return alert("Failed to log payment");
    const created = await r.json();
    setEntries((cur) =>
      cur.map((e) => (e.id !== entryId ? e : { ...e, debtPayments: [created, ...e.debtPayments] }))
    );
  }

  async function undoDebtPayment(entryId: string, paymentId: string) {
    const r = await fetch(`/api/entries/${entryId}/debt-payments/${paymentId}`, { method: "DELETE" });
    if (!r.ok) return alert("Failed to undo payment");
    setEntries((cur) =>
      cur.map((e) =>
        e.id !== entryId ? e : { ...e, debtPayments: e.debtPayments.filter((p) => p.id !== paymentId) }
      )
    );
  }

  const income = useMemo(() => entries.filter((e) => e.type === "income"), [entries]);
  const expenses = useMemo(() => entries.filter((e) => e.type === "expense"), [entries]);
  const purchases = useMemo(() => entries.filter((e) => e.type === "purchase"), [entries]);
  const debts = useMemo(() => {
    return entries
      .filter((e) => e.type === "debt")
      .map((e) => {
        const paidSoFar = e.debtPayments.reduce(
          (s, p) => s + (p.kind === "charge" ? 0 : p.amount),
          0
        );
        const chargedSoFar = e.debtPayments.reduce(
          (s, p) => s + (p.kind === "charge" ? p.amount : 0),
          0
        );
        return {
          ...e,
          originalAmount: e.amount,
          paidSoFar,
          chargedSoFar,
          amount: Math.max(0, e.amount + chargedSoFar - paidSoFar),
        };
      });
  }, [entries]);

  const sumBy = (arr: Entry[], pred?: (e: Entry) => boolean) =>
    arr.reduce((s, e) => s + (!pred || pred(e) ? e.amount : 0), 0);
  const totalDebt = useMemo(() => sumBy(debts), [debts]);

  // Month-by-month ledger. Each month starts with whatever was left over
  // from the previous one, so unspent money carries forward instead of
  // every month resetting to the same static surplus.
  const ledger = useMemo(() => {
    const months: string[] = [];
    for (let m = startMonth; m <= currentMonth; m = shiftMonth(m, 1)) months.push(m);

    const bornIn = (e: Entry) => monthKey(new Date(e.createdAt));
    const activeIn = (e: Entry, month: string) =>
      e.frequency === "monthly" ? bornIn(e) <= month : bornIn(e) === month;

    let carry = 0;
    return months.map((month) => {
      const inc = income.filter((e) => activeIn(e, month));
      const exp = expenses.filter((e) => activeIn(e, month));
      const gotPaid = (e: Entry) => e.payments.some((p) => p.month === month);
      // One-off entries are settled the month they're logged; recurring ones
      // only count once they're actually marked received / paid.
      const settled = (e: Entry) => e.frequency !== "monthly" || gotPaid(e);
      const fromBalance = (e: Entry) =>
        e.frequency !== "monthly" || e.payments.some((p) => p.month === month && p.fromBalance);

      const expectedIncome = sumBy(inc);
      const receivedIncome = sumBy(inc, settled);
      const billsDue = sumBy(exp);
      const billsPaid = sumBy(exp, settled);
      const billsUnpaid = billsDue - billsPaid;
      const spentFromBalance = sumBy(exp, (e) => settled(e) && fromBalance(e));

      // Purchases are already-spent money — they hit the balance the month
      // they're logged, with no paid/unpaid state to track.
      const purchaseSpend = sumBy(purchases.filter((e) => bornIn(e) === month));

      const debtPaid = debts.reduce(
        (s, d) =>
          s +
          d.debtPayments.reduce(
            (ps, p) =>
              ps +
              (p.kind === "payment" && p.fromBalance && monthKey(new Date(p.paidAt)) === month
                ? p.amount
                : 0),
            0
          ),
        0
      );

      const carryIn = carry;
      const closing = carryIn + receivedIncome - spentFromBalance - purchaseSpend - debtPaid;
      carry = closing;
      return {
        month,
        carryIn,
        expectedIncome,
        receivedIncome,
        billsDue,
        billsPaid,
        billsUnpaid,
        spentFromBalance,
        purchaseSpend,
        debtPaid,
        closing,
        // What's genuinely free once this month's remaining bills are covered.
        available: closing - billsUnpaid,
      };
    });
  }, [income, expenses, purchases, debts, startMonth, currentMonth]);

  const monthRow = useMemo(
    () => ledger.find((r) => r.month === selectedMonth) ?? ledger[ledger.length - 1],
    [ledger, selectedMonth]
  );
  const balance = monthRow?.closing ?? 0;
  const monthlySurplus = monthRow?.available ?? 0;
  const monthlyIncome = monthRow?.receivedIncome ?? 0;
  const totalIncome = monthRow?.receivedIncome ?? 0;
  const totalExpense = monthRow?.billsDue ?? 0;
  const totalPurchases = monthRow?.purchaseSpend ?? 0;
  const dti = monthlyIncome > 0 ? totalDebt / (monthlyIncome * 12) : 0;
  const monthlyToDebt = Math.max(0, monthlySurplus * (payoutPct / 100));

  // Amortization simulation: minimums on every debt, extra rolls into the
  // target debt, freed minimums snowball forward, interest accrues monthly.
  const [whatIfExtra, setWhatIfExtra] = useState(0);

  const plan = useMemo(
    () => simulatePayoff(debts, strategy, monthlyToDebt),
    [debts, strategy, monthlyToDebt]
  );
  const altPlan = useMemo(
    () => simulatePayoff(debts, strategy === "avalanche" ? "snowball" : "avalanche", monthlyToDebt),
    [debts, strategy, monthlyToDebt]
  );
  const whatIfPlan = useMemo(
    () => (whatIfExtra > 0 ? simulatePayoff(debts, strategy, monthlyToDebt + whatIfExtra) : null),
    [debts, strategy, monthlyToDebt, whatIfExtra]
  );
  const payoffOrder = plan.order;
  const monthsToClear = debts.length === 0 ? 0 : plan.monthsToClear;

  // Overall payoff progress across all debts (paid vs everything owed so far).
  const totalOwedEver = useMemo(
    () => debts.reduce((s, d) => s + (d.originalAmount ?? d.amount) + (d.chargedSoFar ?? 0), 0),
    [debts]
  );
  const overallProgress = totalOwedEver > 0 ? 1 - totalDebt / totalOwedEver : 0;
  const milestone =
    totalOwedEver <= 0 ? null
    : overallProgress >= 1 ? { pct: 100, msg: "DEBT-FREE! Every balance cleared. 🎉" }
    : overallProgress >= 0.75 ? { pct: 75, msg: "75% of your debt is gone — the finish line is visible." }
    : overallProgress >= 0.5 ? { pct: 50, msg: "Halfway there — over half your debt is paid off." }
    : overallProgress >= 0.25 ? { pct: 25, msg: "First quarter down — momentum is building." }
    : null;

  async function addEntry(payload: { type: EntryType; label: string; amount: number; frequency: "once" | "monthly"; apr?: number; minPayment?: number; dueDay?: number; note?: string }) {
    setBusy(true);
    const r = await fetch("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!r.ok) return alert("Failed to add entry");
    const created: Entry = await r.json();
    setEntries((cur) => [created, ...cur]);
    setModalType(null);
  }

  async function deleteEntry(id: string) {
    if (!confirm("Delete this entry?")) return;
    const r = await fetch(`/api/entries/${id}`, { method: "DELETE" });
    if (!r.ok) return alert("Failed to delete");
    setEntries((cur) => cur.filter((e) => e.id !== id));
  }

  const suggestions = buildSuggestions({
    totalIncome,
    totalExpense,
    totalDebt,
    surplus: monthlySurplus,
    dti,
    monthsToClear,
    debtCount: debts.length,
    biggestDebt: debts.length ? [...debts].sort((a, b) => b.amount - a.amount)[0] : null,
    smallestDebt: debts.length ? [...debts].sort((a, b) => a.amount - b.amount)[0] : null,
  });

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">
            Hello, <span className="text-emerald-400">{userName || userEmail.split("@")[0]}</span>
          </h1>
          <p className="text-slate-400 text-sm">Your money, tracked.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-slate-900/60 border border-slate-800 rounded-xl px-1 py-1">
            <button
              onClick={() => setSelectedMonth((m) => shiftMonth(m, -1))}
              disabled={selectedMonth <= startMonth}
              className="px-2 py-1.5 rounded-lg text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent"
              title="Previous month"
            >
              ‹
            </button>
            <span className="px-2 text-sm font-medium tabular-nums min-w-[9rem] text-center">
              {monthDisplay(selectedMonth)}
            </span>
            <button
              onClick={() => setSelectedMonth((m) => shiftMonth(m, 1))}
              disabled={selectedMonth >= currentMonth}
              className="px-2 py-1.5 rounded-lg text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent"
              title="Next month"
            >
              ›
            </button>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
            className="p-2.5 rounded-xl border border-slate-700 hover:bg-slate-800 transition text-slate-300 hover:text-white"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="px-4 py-2 rounded-xl border border-slate-700 hover:bg-slate-800 transition text-sm whitespace-nowrap"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Summary cards */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard
          label="Balance"
          value={fmt(balance)}
          accent={balance >= 0 ? "emerald" : "rose"}
          sub={
            monthRow && monthRow.carryIn !== 0
              ? `${fmt(monthRow.carryIn)} carried in`
              : "Left at end of this month"
          }
        />
        <StatCard
          label="Bills"
          value={fmt(totalExpense)}
          accent="rose"
          sub={
            monthRow && monthRow.billsUnpaid > 0
              ? `${fmt(monthRow.billsUnpaid)} still unpaid`
              : monthRow && monthRow.billsDue > 0
              ? "All bills paid"
              : undefined
          }
        />
        <StatCard
          label="Purchases"
          value={fmt(totalPurchases)}
          accent="violet"
          sub="Spent this month"
        />
        <StatCard label="Debt" value={fmt(totalDebt)} accent="amber" />
        <StatCard
          label="Free to spend"
          value={fmt(monthlySurplus)}
          accent={monthlySurplus >= 0 ? "sky" : "rose"}
          sub={
            monthRow && monthRow.billsUnpaid > 0
              ? `After ${fmt(monthRow.billsUnpaid)} of bills left`
              : "Bills covered — all yours"
          }
        />
      </section>

      {monthRow && (
        <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold">{monthDisplay(selectedMonth)} ledger</h2>
            {monthRow.expectedIncome > monthRow.receivedIncome && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                {fmt(monthRow.expectedIncome - monthRow.receivedIncome)} income not received yet
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm tabular-nums">
            <LedgerBit label="Carried in" value={monthRow.carryIn} tone="slate" />
            <span className="text-slate-600">+</span>
            <LedgerBit label="Income received" value={monthRow.receivedIncome} tone="emerald" />
            <span className="text-slate-600">−</span>
            <LedgerBit label="Bills paid" value={monthRow.spentFromBalance} tone="rose" />
            <span className="text-slate-600">−</span>
            <LedgerBit label="Purchases" value={monthRow.purchaseSpend} tone="violet" />
            <span className="text-slate-600">−</span>
            <LedgerBit label="Debt paid" value={monthRow.debtPaid} tone="amber" />
            <span className="text-slate-600">=</span>
            <LedgerBit label="Left over" value={monthRow.closing} tone="sky" strong />
          </div>
          <p className="text-xs text-slate-500 mt-3">
            Whatever's left rolls into {monthDisplay(shiftMonth(selectedMonth, 1))}. Mark income as
            received when it actually lands — nothing counts until you confirm it.
          </p>
        </section>
      )}

      {milestone && (
        <section
          className={`rounded-2xl border p-4 flex items-center gap-4 ${
            milestone.pct === 100
              ? "bg-emerald-500/15 border-emerald-500/40"
              : "bg-emerald-500/10 border-emerald-500/25"
          }`}
        >
          <span className="text-3xl">{milestone.pct === 100 ? "🏆" : "🎯"}</span>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-emerald-300">{milestone.pct === 100 ? "Debt-free!" : `${milestone.pct}% paid off`}</p>
            <p className="text-sm text-slate-300">{milestone.msg}</p>
            <div className="mt-2 h-2 w-full bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all"
                style={{ width: `${Math.min(100, overallProgress * 100)}%` }}
              />
            </div>
          </div>
        </section>
      )}

      {/* Category tables */}
      <section className="grid md:grid-cols-2 xl:grid-cols-4 gap-6">
        <CategoryTable
          title="Income"
          color="emerald"
          rows={income}
          total={totalIncome}
          onAdd={() => setModalType("income")}
          onDelete={deleteEntry}
          selectedMonth={selectedMonth}
          onTogglePaid={(id, paid) => toggleReceived(id, paid)}
          payBusy={payBusy}
          paidLabels={{ header: "Got it", yes: "✓ Received", no: "Mark received" }}
        />
        <CategoryTable
          title="Bills"
          color="rose"
          rows={expenses}
          total={totalExpense}
          onAdd={() => setModalType("expense")}
          onDelete={deleteEntry}
          selectedMonth={selectedMonth}
          onTogglePaid={togglePaid}
          payBusy={payBusy}
        />
        <CategoryTable
          title="Purchases"
          color="violet"
          rows={purchases.filter((e) => monthKey(new Date(e.createdAt)) === selectedMonth)}
          total={totalPurchases}
          onAdd={() => setModalType("purchase")}
          onDelete={deleteEntry}
        />
        <CategoryTable
          title="Debt"
          color="amber"
          rows={debts}
          total={totalDebt}
          onAdd={() => setModalType("debt")}
          onDelete={deleteEntry}
          showShare
          onLogPayment={(id, label) => setDebtModal({ id, label })}
        />
      </section>

      {/* Summary table */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-lg font-bold">Monthly summary</h2>
          <span className="text-xs text-slate-500">All numbers combined</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-slate-400 text-xs uppercase">
            <tr>
              <th className="text-left px-5 py-3">Category</th>
              <th className="text-right px-5 py-3">Entries</th>
              <th className="text-right px-5 py-3">Total</th>
              <th className="text-right px-5 py-3 hidden sm:table-cell">% of Income</th>
              <th className="text-left px-5 py-3 hidden md:table-cell">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            <SumRow label="Income" count={income.length} total={totalIncome} pctOfIncome={1} color="emerald" />
            <SumRow
              label="Bills"
              count={expenses.length}
              total={-totalExpense}
              pctOfIncome={totalIncome ? -totalExpense / totalIncome : 0}
              color="rose"
            />
            <SumRow
              label="Purchases"
              count={purchases.filter((e) => monthKey(new Date(e.createdAt)) === selectedMonth).length}
              total={-totalPurchases}
              pctOfIncome={totalIncome ? -totalPurchases / totalIncome : 0}
              color="violet"
            />
            <SumRow
              label="Debt"
              count={debts.length}
              total={-totalDebt}
              pctOfIncome={totalIncome ? -totalDebt / totalIncome : 0}
              color="amber"
              note={`DTI ratio ${pct(dti)}`}
            />
            <tr className="bg-slate-900/80 font-bold">
              <td className="px-5 py-3">Net balance</td>
              <td className="px-5 py-3 text-right text-slate-400">{entries.length}</td>
              <td className={`px-5 py-3 text-right tabular-nums ${balance >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {fmt(balance)}
              </td>
              <td className="px-5 py-3 text-right hidden sm:table-cell text-slate-400">
                {totalIncome ? pct(balance / totalIncome) : "—"}
              </td>
              <td className="px-5 py-3 hidden md:table-cell text-slate-500">
                Income − Bills − Purchases − Debt payments from balance
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Debt payment plan */}
      <section className="bg-gradient-to-br from-amber-500/10 via-slate-900 to-slate-900 border border-amber-500/30 rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2">
              <span>Debt payment plan</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                Smart plan
              </span>
            </h2>
            <p className="text-slate-400 text-sm">
              Driven by what's <span className="text-sky-300">free after this month's bills</span> ({fmt(monthlySurplus)}).
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex bg-slate-800 border border-slate-700 rounded-xl p-1">
              <button
                onClick={() => setStrategy("avalanche")}
                className={`px-3 py-1.5 rounded-lg text-sm transition ${
                  strategy === "avalanche" ? "bg-amber-500 text-slate-950 font-semibold" : "text-slate-300"
                }`}
              >
                Avalanche
              </button>
              <button
                onClick={() => setStrategy("snowball")}
                className={`px-3 py-1.5 rounded-lg text-sm transition ${
                  strategy === "snowball" ? "bg-amber-500 text-slate-950 font-semibold" : "text-slate-300"
                }`}
              >
                Snowball
              </button>
            </div>
          </div>
        </div>

        {plan.monthsToClear !== Infinity && altPlan.monthsToClear !== Infinity && debts.length > 1 &&
          Math.abs(plan.totalInterest - altPlan.totalInterest) >= 1 && (
          <p className="text-xs text-slate-400 -mt-2 mb-4">
            {plan.totalInterest <= altPlan.totalInterest ? (
              <>
                <span className="text-emerald-300 font-semibold capitalize">{strategy}</span> saves{" "}
                <span className="text-emerald-300">{fmt(altPlan.totalInterest - plan.totalInterest)}</span> in interest
                {altPlan.monthsToClear > plan.monthsToClear &&
                  ` and ${altPlan.monthsToClear - plan.monthsToClear} month${altPlan.monthsToClear - plan.monthsToClear === 1 ? "" : "s"}`}{" "}
                vs {strategy === "avalanche" ? "snowball" : "avalanche"}.
              </>
            ) : (
              <>
                Switching to{" "}
                <span className="text-amber-300 font-semibold">{strategy === "avalanche" ? "snowball" : "avalanche"}</span>{" "}
                would save <span className="text-amber-300">{fmt(plan.totalInterest - altPlan.totalInterest)}</span> in interest.
              </>
            )}
          </p>
        )}

        <div className="grid sm:grid-cols-4 gap-3 mb-5">
          <MiniStat label="Apply to debt / mo" value={fmt(monthlyToDebt)} />
          <MiniStat
            label="Debt-free date"
            value={monthsToClear === Infinity ? "∞" : monthsToClear === 0 ? "Now" : monthLabel(monthsToClear)}
          />
          <MiniStat
            label="Interest you'll pay"
            value={plan.totalInterest === Infinity ? "∞" : fmt(plan.totalInterest)}
          />
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
            <p className="text-xs uppercase tracking-wider text-slate-500">Surplus % to debt</p>
            <div className="flex items-center gap-3 mt-2">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={payoutPct}
                onChange={(e) => setPayoutPct(parseInt(e.target.value))}
                className="flex-1 accent-amber-500"
              />
              <span className="text-amber-300 font-semibold w-12 text-right tabular-nums">{payoutPct}%</span>
            </div>
          </div>
        </div>

        {debts.length > 0 && (
          <div className="grid md:grid-cols-2 gap-3 mb-5">
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
              <p className="text-xs uppercase tracking-wider text-slate-500 mb-2">
                What if I paid more each month?
              </p>
              <div className="flex items-center gap-3">
                <span className="text-slate-400 text-sm">+</span>
                <input
                  type="number"
                  min={0}
                  step={10}
                  value={whatIfExtra || ""}
                  placeholder="0"
                  onChange={(e) => setWhatIfExtra(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-24 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 focus:border-amber-500 outline-none text-sm tabular-nums"
                />
                <span className="text-slate-400 text-sm">/mo extra</span>
              </div>
              {whatIfPlan && plan.monthsToClear !== Infinity && whatIfPlan.monthsToClear !== Infinity && (
                <p className="text-sm mt-2 text-emerald-300">
                  Debt-free {plan.monthsToClear - whatIfPlan.monthsToClear} month
                  {plan.monthsToClear - whatIfPlan.monthsToClear === 1 ? "" : "s"} sooner, save{" "}
                  {fmt(Math.max(0, plan.totalInterest - whatIfPlan.totalInterest))} in interest.
                </p>
              )}
              {whatIfPlan && plan.monthsToClear === Infinity && whatIfPlan.monthsToClear !== Infinity && (
                <p className="text-sm mt-2 text-emerald-300">
                  That extra makes you debt-free in {whatIfPlan.monthsToClear} months — right now you never get there.
                </p>
              )}
            </div>
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
              <p className="text-xs uppercase tracking-wider text-slate-500 mb-1">Balance over time</p>
              {plan.monthsToClear === Infinity ? (
                <p className="text-sm text-slate-500 italic mt-2">
                  Payments don't cover interest — balance never reaches zero. Raise the slider.
                </p>
              ) : (
                <PayoffChart timeline={(whatIfPlan ?? plan).timeline} />
              )}
            </div>
          </div>
        )}

        {debts.length === 0 ? (
          <p className="text-slate-400 italic">No debts logged. Hit "+ Debt" to start planning.</p>
        ) : (
          <div className="overflow-x-auto bg-slate-900/60 border border-slate-800 rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-slate-400 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-3">#</th>
                  <th className="text-left px-4 py-3">Debt</th>
                  <th className="text-right px-4 py-3">Balance</th>
                  <th className="text-right px-4 py-3 hidden sm:table-cell">APR</th>
                  <th className="text-right px-4 py-3 hidden lg:table-cell">Interest</th>
                  <th className="text-right px-4 py-3">Months</th>
                  <th className="text-right px-4 py-3 hidden md:table-cell">Cleared by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {payoffOrder.map((d, i) => (
                  <tr key={d.id} className="hover:bg-amber-500/5">
                    <td className="px-4 py-3 text-slate-500">{i + 1}</td>
                    <td className="px-4 py-3 font-medium">
                      {d.label}
                      {i === 0 && (
                        <span className="ml-2 text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">
                          attack first
                        </span>
                      )}
                      {(d.originalAmount ?? 0) > 0 && (
                        <div className="mt-1.5 h-1.5 w-full max-w-[160px] bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-emerald-500 rounded-full"
                            style={{
                              width: `${Math.min(100, Math.max(0, (1 - d.amount / Math.max(d.originalAmount ?? d.amount, d.amount)) * 100))}%`,
                            }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-amber-300">{fmt(d.amount)}</td>
                    <td className="px-4 py-3 text-right hidden sm:table-cell text-slate-400 tabular-nums">
                      {d.apr != null ? `${d.apr}%` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right hidden lg:table-cell text-rose-300/80 tabular-nums">
                      {d.interest > 0 ? fmt(d.interest) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {d.months === Infinity ? "∞" : `${d.months} mo`}
                    </td>
                    <td className="px-4 py-3 text-right hidden md:table-cell text-slate-400">
                      {d.eta === Infinity ? "—" : monthLabel(d.eta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="mt-5 grid sm:grid-cols-2 gap-3">
            {suggestions.map((s, i) => (
              <div
                key={i}
                className={`rounded-xl p-4 border ${
                  s.tone === "good"
                    ? "bg-emerald-500/10 border-emerald-500/30"
                    : s.tone === "warn"
                    ? "bg-amber-500/10 border-amber-500/30"
                    : "bg-rose-500/10 border-rose-500/30"
                }`}
              >
                <p className="font-semibold text-white">{s.title}</p>
                <p className="text-sm text-slate-300 mt-1">{s.body}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {modalType && (
        <EntryModal
          type={modalType}
          onClose={() => setModalType(null)}
          onSubmit={addEntry}
          busy={busy}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          currency={currency}
          onClose={() => setSettingsOpen(false)}
          onSaved={(code) => {
            setCurrency(code);
            setSettingsOpen(false);
          }}
        />
      )}

      {payPrompt && (
        <PaySourceModal
          label={payPrompt.label}
          amount={payPrompt.amount}
          busy={payBusy === payPrompt.id}
          debts={debts.map((d) => ({ id: d.id, label: d.label, amount: d.amount }))}
          onClose={() => setPayPrompt(null)}
          onChoose={(source, debtEntryId) => markPaid(payPrompt.id, source, debtEntryId)}
        />
      )}

      {debtModal && (() => {
        const entry = debts.find((d) => d.id === debtModal.id);
        if (!entry) return null;
        return (
          <DebtPaymentModal
            label={debtModal.label}
            remaining={entry.amount}
            originalAmount={entry.originalAmount ?? entry.amount}
            history={entry.debtPayments}
            busy={debtPayBusy}
            onClose={() => setDebtModal(null)}
            onLogPayment={(amount, kind, fromBalance, note) =>
              logDebtPayment(debtModal.id, amount, kind, fromBalance, note)
            }
            onUndo={(paymentId) => undoDebtPayment(debtModal.id, paymentId)}
          />
        );
      })()}
    </main>
  );
}

/* ---------- subcomponents ---------- */

function CategoryTable({
  title,
  color,
  rows,
  total,
  onAdd,
  onDelete,
  showShare,
  selectedMonth,
  onTogglePaid,
  payBusy,
  onLogPayment,
  paidLabels,
}: {
  title: string;
  color: "emerald" | "rose" | "amber" | "violet";
  rows: Entry[];
  total: number;
  onAdd: () => void;
  onDelete: (id: string) => void;
  showShare?: boolean;
  selectedMonth?: string;
  onTogglePaid?: (id: string, paid: boolean, label: string, amount: number) => void;
  payBusy?: string | null;
  onLogPayment?: (id: string, label: string) => void;
  paidLabels?: { header: string; yes: string; no: string };
}) {
  const marks = paidLabels ?? { header: "Paid", yes: "✓ Paid", no: "Mark paid" };
  const map = {
    emerald: { bar: "bg-emerald-500", text: "text-emerald-400", chip: "bg-emerald-500/15 border-emerald-500/30", btn: "bg-emerald-500 hover:bg-emerald-400 text-slate-950" },
    rose: { bar: "bg-rose-500", text: "text-rose-400", chip: "bg-rose-500/15 border-rose-500/30", btn: "bg-rose-500 hover:bg-rose-400 text-white" },
    amber: { bar: "bg-amber-500", text: "text-amber-400", chip: "bg-amber-500/15 border-amber-500/30", btn: "bg-amber-500 hover:bg-amber-400 text-slate-950" },
    violet: { bar: "bg-violet-500", text: "text-violet-400", chip: "bg-violet-500/15 border-violet-500/30", btn: "bg-violet-500 hover:bg-violet-400 text-white" },
  }[color];
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
      <div className={`h-1 ${map.bar}`} />
      <div className="px-5 py-4 flex items-center justify-between border-b border-slate-800">
        <div>
          <h3 className="text-lg font-bold">{title}</h3>
          <p className={`text-sm tabular-nums ${map.text} font-semibold`}>{fmt(total)}</p>
        </div>
        <button onClick={onAdd} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${map.btn}`}>
          + Add
        </button>
      </div>
      <div className="overflow-x-auto flex-1">
        <table className="w-full text-sm">
          <thead className="text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">Label</th>
              <th className="text-right px-4 py-2">Amount</th>
              {showShare && <th className="text-right px-4 py-2">Share</th>}
              {onTogglePaid && <th className="text-center px-4 py-2">{marks.header}</th>}
              <th className="px-4 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.length === 0 && (
              <tr>
                <td colSpan={(showShare ? 4 : 3) + (onTogglePaid ? 1 : 0)} className="text-center py-8 text-slate-500 italic">
                  Empty — click + Add
                </td>
              </tr>
            )}
            {rows.map((e) => {
              const paid = !!selectedMonth && e.payments.some((p) => p.month === selectedMonth);
              return (
              <tr key={e.id} className={`hover:bg-slate-800/40 ${paid ? "bg-emerald-500/5" : ""}`}>
                <td className="px-4 py-2.5">
                  <p className="font-medium truncate flex items-center gap-2">
                    {e.label}
                    {e.type === "purchase" ? (
                      <span className="text-[10px] uppercase tracking-wider text-slate-500">
                        {new Date(e.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    ) : (
                      <span
                        className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                          e.frequency === "monthly"
                            ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                            : "bg-slate-700/50 text-slate-400 border border-slate-600/40"
                        }`}
                      >
                        {e.frequency === "monthly" ? "Monthly" : "Once"}
                      </span>
                    )}
                    {onLogPayment && e.dueDay != null && e.amount > 0 && daysUntilDue(e.dueDay) <= 7 && (
                      <span
                        className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                          daysUntilDue(e.dueDay) === 0
                            ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                            : "bg-amber-500/20 text-amber-300 border-amber-500/40"
                        }`}
                      >
                        {daysUntilDue(e.dueDay) === 0 ? "Due today" : `Due in ${daysUntilDue(e.dueDay)}d`}
                      </span>
                    )}
                  </p>
                  {e.note && <p className="text-xs text-slate-500 truncate">{e.note}</p>}
                  {onLogPayment && (!!e.paidSoFar || !!e.chargedSoFar) && (
                    <p className="text-xs text-slate-500 truncate">
                      {fmt(e.paidSoFar ?? 0)} paid
                      {e.chargedSoFar ? ` · ${fmt(e.chargedSoFar)} used` : ""} · started {fmt(e.originalAmount ?? e.amount)}
                    </p>
                  )}
                </td>
                <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${map.text}`}>
                  {fmt(e.amount)}
                </td>
                {showShare && (
                  <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums">
                    {total ? pct(e.amount / total) : "—"}
                  </td>
                )}
                {onTogglePaid && (
                  <td className="px-4 py-2.5 text-center">
                    {e.frequency === "monthly" ? (
                      <button
                        onClick={() => onTogglePaid(e.id, paid, e.label, e.amount)}
                        disabled={payBusy === e.id}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition disabled:opacity-50 ${
                          paid
                            ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                            : "bg-slate-800 border-slate-700 text-slate-400 hover:text-white"
                        }`}
                      >
                        {paid
                          ? e.payments.find((p) => p.month === selectedMonth)?.debtEntryId
                            ? "✓ On card"
                            : marks.yes
                          : marks.no}
                      </button>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                )}
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {onLogPayment && (
                      <button
                        onClick={() => onLogPayment(e.id, e.label)}
                        className="px-2 py-1 rounded-lg text-xs font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25"
                      >
                        + Payment
                      </button>
                    )}
                    <button
                      onClick={() => onDelete(e.id)}
                      className="text-slate-500 hover:text-rose-400"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: string;
  accent: "emerald" | "rose" | "amber" | "sky" | "violet";
  sub?: string;
}) {
  const colors: Record<string, string> = {
    emerald: "from-emerald-500/20 to-emerald-500/0 border-emerald-500/30",
    rose: "from-rose-500/20 to-rose-500/0 border-rose-500/30",
    amber: "from-amber-500/20 to-amber-500/0 border-amber-500/30",
    sky: "from-sky-500/20 to-sky-500/0 border-sky-500/30",
    violet: "from-violet-500/20 to-violet-500/0 border-violet-500/30",
  };
  return (
    <div className={`bg-gradient-to-br ${colors[accent]} border rounded-2xl p-4`}>
      <p className="text-xs uppercase tracking-wider opacity-80">{label}</p>
      <p className="text-2xl font-bold mt-2 tabular-nums text-white">{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

function LedgerBit({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: number;
  tone: "slate" | "emerald" | "rose" | "amber" | "sky" | "violet";
  strong?: boolean;
}) {
  const colors = {
    slate: "text-slate-300 border-slate-700",
    emerald: "text-emerald-300 border-emerald-500/30",
    rose: "text-rose-300 border-rose-500/30",
    amber: "text-amber-300 border-amber-500/30",
    sky: "text-sky-300 border-sky-500/40",
    violet: "text-violet-300 border-violet-500/30",
  }[tone];
  return (
    <span className={`px-3 py-1.5 rounded-xl bg-slate-900/70 border ${colors} ${strong ? "font-bold" : ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-2">{label}</span>
      {fmt(value)}
    </span>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
      <p className="text-xs uppercase tracking-wider text-slate-500">{label}</p>
      <p className="text-xl font-bold tabular-nums mt-1">{value}</p>
    </div>
  );
}

function SumRow({
  label,
  count,
  total,
  pctOfIncome,
  color,
  note,
}: {
  label: string;
  count: number;
  total: number;
  pctOfIncome: number;
  color: "emerald" | "rose" | "amber" | "violet";
  note?: string;
}) {
  const map = {
    emerald: "text-emerald-400",
    rose: "text-rose-400",
    amber: "text-amber-400",
    violet: "text-violet-400",
  };
  return (
    <tr className="hover:bg-slate-800/30">
      <td className="px-5 py-3 font-medium">{label}</td>
      <td className="px-5 py-3 text-right text-slate-400">{count}</td>
      <td className={`px-5 py-3 text-right tabular-nums font-semibold ${map[color]}`}>{fmt(total)}</td>
      <td className="px-5 py-3 text-right hidden sm:table-cell text-slate-400">{pct(pctOfIncome)}</td>
      <td className="px-5 py-3 hidden md:table-cell text-slate-500">{note ?? ""}</td>
    </tr>
  );
}

function EntryModal({
  type,
  onClose,
  onSubmit,
  busy,
}: {
  type: EntryType;
  onClose: () => void;
  onSubmit: (p: { type: EntryType; label: string; amount: number; frequency: "once" | "monthly"; apr?: number; minPayment?: number; dueDay?: number; note?: string }) => void;
  busy: boolean;
}) {
  useEscapeClose(onClose);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [apr, setApr] = useState("");
  const [minPayment, setMinPayment] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [frequency, setFrequency] = useState<"once" | "monthly">(
    type === "debt" || type === "purchase" ? "once" : "monthly"
  );

  const titles: Record<EntryType, string> = {
    income: "Add income",
    expense: "Add bill",
    purchase: "Add purchase",
    debt: "Add debt",
  };

  const hints: Record<EntryType, { once: string; monthly: string }> = {
    income: { once: "Bonus, gift, refund — counted once", monthly: "Salary, paycheck — repeats every month" },
    expense: { once: "One-off bill — counted once", monthly: "Rent, subscriptions — repeats every month" },
    purchase: { once: "Something you bought — comes straight out of your balance", monthly: "" },
    debt: { once: "Outstanding balance to pay off", monthly: "Recurring debt payment / installment" },
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = parseFloat(amount);
    if (!label.trim() || isNaN(n) || n <= 0) return;
    const aprN = parseFloat(apr);
    const minN = parseFloat(minPayment);
    const dueN = parseInt(dueDay);
    onSubmit({
      type,
      label: label.trim(),
      amount: n,
      frequency,
      apr: type === "debt" && !isNaN(aprN) && aprN >= 0 ? aprN : undefined,
      minPayment: type === "debt" && !isNaN(minN) && minN > 0 ? minN : undefined,
      dueDay: type === "debt" && !isNaN(dueN) && dueN >= 1 && dueN <= 31 ? dueN : undefined,
      note: note.trim() || undefined,
    });
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm grid place-items-center z-50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold capitalize">{titles[type]}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white">✕</button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {type === "purchase" ? (
            <p className="text-xs text-slate-500">{hints.purchase.once}</p>
          ) : (
          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-400 mb-2">Frequency</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFrequency("once")}
                className={`px-3 py-2.5 rounded-xl border text-sm font-medium transition ${
                  frequency === "once"
                    ? "bg-slate-700 border-slate-500 text-white"
                    : "bg-slate-800 border-slate-700 text-slate-400 hover:text-white"
                }`}
              >
                One-time
              </button>
              <button
                type="button"
                onClick={() => setFrequency("monthly")}
                className={`px-3 py-2.5 rounded-xl border text-sm font-medium transition ${
                  frequency === "monthly"
                    ? "bg-sky-500/20 border-sky-500 text-sky-200"
                    : "bg-slate-800 border-slate-700 text-slate-400 hover:text-white"
                }`}
              >
                Monthly recurring
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-2">{hints[type][frequency]}</p>
          </div>
          )}
          <input
            autoFocus
            placeholder={
              type === "purchase"
                ? "What did you buy? (e.g. Groceries)"
                : "Label (e.g. Salary, Rent, Credit card)"
            }
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 focus:border-emerald-500 outline-none"
          />
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 focus:border-emerald-500 outline-none"
          />
          {type === "debt" && (
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="APR % (optional)"
                value={apr}
                onChange={(e) => setApr(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 focus:border-amber-500 outline-none"
              />
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="Min payment / mo"
                value={minPayment}
                onChange={(e) => setMinPayment(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 focus:border-amber-500 outline-none"
              />
              <input
                type="number"
                step="1"
                min="1"
                max="31"
                placeholder="Due day (1–31)"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
                className="col-span-2 w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 focus:border-amber-500 outline-none"
              />
              <p className="col-span-2 text-xs text-slate-500">
                APR + minimum make the payoff plan accurate; due day shows a reminder before the payment date.
              </p>
            </div>
          )}
          <textarea
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 focus:border-emerald-500 outline-none resize-none"
          />
          <button
            disabled={busy}
            className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </form>
      </div>
    </div>
  );
}

function SettingsModal({
  currency,
  onClose,
  onSaved,
}: {
  currency: string;
  onClose: () => void;
  onSaved: (code: string) => void;
}) {
  useEscapeClose(onClose);
  const [picked, setPicked] = useState(currency);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => {
    const codes = allCurrencies();
    return codes.map((code) => ({ code, name: currencyName(code), symbol: currencySymbol(code) }));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.code.toLowerCase().includes(q) || o.name.toLowerCase().includes(q));
  }, [options, query]);

  async function save() {
    setBusy(true);
    const r = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currency: picked }),
    });
    setBusy(false);
    if (!r.ok) return alert("Failed to save currency");
    onSaved(picked);
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm grid place-items-center z-50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[85vh]"
      >
        <div className="p-6 pb-3 shrink-0">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-xl font-bold">Settings</h2>
            <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none p-1">✕</button>
          </div>
          <p className="text-slate-400 text-sm mb-4">
            Currency — everything is displayed in {currencySymbol(picked)} {picked}.
          </p>
          <input
            autoFocus
            placeholder="Search currency (e.g. euro, CAD)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 focus:border-emerald-500 outline-none"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-6 space-y-1 min-h-0">
          {shown.length === 0 && <p className="text-sm text-slate-500 italic py-4">No currency matches that.</p>}
          {shown.map((o) => (
            <button
              key={o.code}
              onClick={() => setPicked(o.code)}
              className={`w-full text-left px-4 py-3 rounded-xl border transition flex items-center gap-3 ${
                picked === o.code
                  ? "bg-emerald-500/15 border-emerald-500/50"
                  : "bg-slate-800/60 border-slate-700/60 hover:border-slate-600"
              }`}
            >
              <span className="w-12 shrink-0 font-semibold tabular-nums text-slate-300">{o.symbol}</span>
              <span className="flex-1 min-w-0">
                <span className="font-medium">{o.code}</span>
                <span className="block text-xs text-slate-500 truncate">{o.name}</span>
              </span>
              {picked === o.code && <span className="text-emerald-400 shrink-0">✓</span>}
            </button>
          ))}
        </div>

        <div className="p-6 pt-4 shrink-0 border-t border-slate-800">
          <button
            onClick={save}
            disabled={busy}
            className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PaySourceModal({
  label,
  amount,
  busy,
  debts,
  onClose,
  onChoose,
}: {
  label: string;
  amount: number;
  busy: boolean;
  debts: { id: string; label: string; amount: number }[];
  onClose: () => void;
  onChoose: (source: PaySource, debtEntryId?: string) => void;
}) {
  useEscapeClose(onClose);
  const [pickingDebt, setPickingDebt] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm grid place-items-center z-50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-bold">
            {pickingDebt ? "Which card or loan?" : `Mark "${label}" as paid`}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white">✕</button>
        </div>
        <p className="text-slate-400 text-sm mb-4">
          {pickingDebt
            ? `${fmt(amount)} gets added to the debt you pick.`
            : `${fmt(amount)} — where did this payment come from?`}
        </p>

        {pickingDebt ? (
          <div className="space-y-2">
            {debts.map((d) => (
              <button
                key={d.id}
                disabled={busy}
                onClick={() => onChoose("debt", d.id)}
                className="w-full text-left px-4 py-3 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 transition disabled:opacity-50"
              >
                <p className="font-semibold text-amber-300">{d.label}</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {fmt(d.amount)} owed → {fmt(d.amount + amount)} after this
                </p>
              </button>
            ))}
            <button
              onClick={() => setPickingDebt(false)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-700 text-slate-400 hover:text-white text-sm"
            >
              Back
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              disabled={busy}
              onClick={() => onChoose("balance")}
              className="w-full text-left px-4 py-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 transition disabled:opacity-50"
            >
              <p className="font-semibold text-emerald-300">From balance</p>
              <p className="text-xs text-slate-400 mt-0.5">Deducted from your tracked income — reduces balance.</p>
            </button>
            <button
              disabled={busy}
              onClick={() => onChoose("off")}
              className="w-full text-left px-4 py-3 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 transition disabled:opacity-50"
            >
              <p className="font-semibold text-white">Off balance</p>
              <p className="text-xs text-slate-400 mt-0.5">Paid from outside money — balance stays unaffected.</p>
            </button>
            <button
              disabled={busy || debts.length === 0}
              onClick={() => setPickingDebt(true)}
              className="w-full text-left px-4 py-3 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 transition disabled:opacity-40"
            >
              <p className="font-semibold text-amber-300">Paid with card / debt</p>
              <p className="text-xs text-slate-400 mt-0.5">
                {debts.length === 0
                  ? "No debts logged yet — add one to use this."
                  : "Balance untouched; the amount is added to what you owe."}
              </p>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DebtPaymentModal({
  label,
  remaining,
  originalAmount,
  history,
  busy,
  onClose,
  onLogPayment,
  onUndo,
}: {
  label: string;
  remaining: number;
  originalAmount: number;
  history: { id: string; amount: number; kind: string; fromBalance: boolean; note: string | null; paidAt: string }[];
  busy: boolean;
  onClose: () => void;
  onLogPayment: (amount: number, kind: "payment" | "charge", fromBalance: boolean, note?: string) => void;
  onUndo: (paymentId: string) => void;
}) {
  useEscapeClose(onClose);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<"payment" | "charge">("payment");
  const [fromBalance, setFromBalance] = useState(true);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = parseFloat(amount);
    if (isNaN(n) || n <= 0) return;
    onLogPayment(n, kind, kind === "payment" ? fromBalance : false, note.trim() || undefined);
    setAmount("");
    setNote("");
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm grid place-items-center z-50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-bold">Payments — {label}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white">✕</button>
        </div>
        <p className="text-slate-400 text-sm mb-4">
          {fmt(remaining)} remaining · started at {fmt(originalAmount)}
        </p>

        <form onSubmit={submit} className="space-y-2 mb-5">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setKind("payment")}
              className={`px-3 py-2.5 rounded-xl border text-sm font-medium transition ${
                kind === "payment"
                  ? "bg-emerald-500/20 border-emerald-500 text-emerald-200"
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:text-white"
              }`}
            >
              Payment
            </button>
            <button
              type="button"
              onClick={() => setKind("charge")}
              className={`px-3 py-2.5 rounded-xl border text-sm font-medium transition ${
                kind === "charge"
                  ? "bg-rose-500/20 border-rose-500 text-rose-200"
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:text-white"
              }`}
            >
              Card usage
            </button>
          </div>
          <p className="text-xs text-slate-500">
            {kind === "payment"
              ? "Money you paid toward this debt — reduces what you owe."
              : "New spending on this card — increases what you owe."}
          </p>
          {kind === "payment" && (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFromBalance(true)}
                className={`px-3 py-2 rounded-xl border text-xs font-medium transition ${
                  fromBalance
                    ? "bg-sky-500/20 border-sky-500 text-sky-200"
                    : "bg-slate-800 border-slate-700 text-slate-400 hover:text-white"
                }`}
              >
                From balance
              </button>
              <button
                type="button"
                onClick={() => setFromBalance(false)}
                className={`px-3 py-2 rounded-xl border text-xs font-medium transition ${
                  !fromBalance
                    ? "bg-slate-600/40 border-slate-500 text-white"
                    : "bg-slate-800 border-slate-700 text-slate-400 hover:text-white"
                }`}
              >
                Off balance
              </button>
              <p className="col-span-2 text-[11px] text-slate-500">
                {fromBalance
                  ? "Paid with tracked money — your Balance goes down."
                  : "Paid with outside money — Balance unaffected."}
              </p>
            </div>
          )}
          <input
            autoFocus
            type="number"
            step="0.01"
            min="0.01"
            placeholder={kind === "payment" ? "Payment amount" : "Amount spent"}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 focus:border-amber-500 outline-none"
          />
          <input
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 focus:border-amber-500 outline-none"
          />
          <button
            disabled={busy}
            className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold disabled:opacity-50"
          >
            {busy ? "Logging..." : kind === "payment" ? "Log payment" : "Log card usage"}
          </button>
        </form>

        <p className="text-xs uppercase tracking-wider text-slate-500 mb-2">History</p>
        {history.length === 0 ? (
          <p className="text-sm text-slate-500 italic">No payments logged yet.</p>
        ) : (
          <div className="space-y-1.5">
            {history.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2"
              >
                <div className="min-w-0">
                  <p className={`font-medium tabular-nums ${p.kind === "charge" ? "text-rose-300" : "text-emerald-300"}`}>
                    {p.kind === "charge" ? `+${fmt(p.amount)}` : `−${fmt(p.amount)}`}
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-slate-500">
                      {p.kind === "charge" ? "Usage" : p.fromBalance ? "Payment · from balance" : "Payment · off balance"}
                    </span>
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    {new Date(p.paidAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                    {p.note ? ` · ${p.note}` : ""}
                  </p>
                </div>
                <button
                  onClick={() => onUndo(p.id)}
                  className="text-xs text-slate-500 hover:text-rose-400 shrink-0"
                >
                  Undo
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

type SimDebt = Entry & { originalAmount?: number; paidSoFar?: number; chargedSoFar?: number };

// Amortization simulation: minimums on every debt, extra rolls into the
// target debt, freed minimums snowball forward, interest accrues monthly.
function simulatePayoff(debts: SimDebt[], strategy: "avalanche" | "snowball", extraPerMonth: number) {
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

function PayoffChart({ timeline }: { timeline: number[] }) {
  if (timeline.length < 2) return null;
  const W = 600;
  const H = 120;
  const max = Math.max(...timeline, 1);
  const pts = timeline
    .map((v, i) => `${((i / (timeline.length - 1)) * W).toFixed(1)},${(H - (v / max) * (H - 8) - 4).toFixed(1)}`)
    .join(" ");
  const area = `0,${H} ${pts} ${W},${H}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" preserveAspectRatio="none" aria-label="Debt balance over time">
      <defs>
        <linearGradient id="payoffFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#payoffFill)" />
      <polyline points={pts} fill="none" stroke="#f59e0b" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function monthLabel(monthsFromNow: number) {
  const d = new Date();
  d.setMonth(d.getMonth() + monthsFromNow);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

type Suggestion = { title: string; body: string; tone: "good" | "warn" | "bad" };

function buildSuggestions(ctx: {
  totalIncome: number;
  totalExpense: number;
  totalDebt: number;
  surplus: number;
  dti: number;
  monthsToClear: number;
  debtCount: number;
  biggestDebt: Entry | null;
  smallestDebt: Entry | null;
}): Suggestion[] {
  const out: Suggestion[] = [];

  if (ctx.totalIncome === 0) {
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
