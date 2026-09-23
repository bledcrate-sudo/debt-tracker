"use client";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { signOut } from "next-auth/react";
import { usePlaidLink } from "react-plaid-link";
import {
  type EntryType,
  type PaySource,
  type Entry,
  type Formatter,
  type SimDebt,
  makeFmt,
  allCurrencies,
  currencyName,
  currencySymbol,
  pct,
  monthKey,
  shiftMonth,
  monthDisplay,
  daysUntilDue,
  paidSinceLastDue,
  bornIn,
  activeIn,
  simulatePayoff,
  monthLabel,
  buildSuggestions,
} from "./lib";

// Provided by Dashboard so every subcomponent formats in the signed-in user's
// currency without threading a prop through each one; the default here only
// covers a component rendered outside that provider (shouldn't happen).
const CurrencyContext = createContext<Formatter>(makeFmt("USD"));

function useEscapeClose(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}

export default function Dashboard({
  initialEntries,
  userEmail,
  userName,
  userCurrency,
  userBalanceAdjustment,
}: {
  initialEntries: Entry[];
  userEmail: string;
  userName: string | null;
  userCurrency: string;
  userBalanceAdjustment: number;
}) {
  const [currency, setCurrency] = useState(userCurrency);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fmt = useMemo(() => makeFmt(currency), [currency]);

  const [balanceAdjustment, setBalanceAdjustment] = useState(userBalanceAdjustment);
  const [adjustBalanceOpen, setAdjustBalanceOpen] = useState(false);

  // The iOS build is a thin webview over the deployed site with no offline
  // cache, so losing the network mid-session otherwise fails silently.
  const [isOffline, setIsOffline] = useState(false);
  useEffect(() => {
    setIsOffline(!navigator.onLine);
    const goOnline = () => setIsOffline(false);
    const goOffline = () => setIsOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

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

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!errorMsg) return;
    const t = setTimeout(() => setErrorMsg(null), 7000);
    return () => clearTimeout(t);
  }, [errorMsg]);
  async function reportError(r: Response, fallback: string) {
    const body = await r.json().catch(() => null);
    setErrorMsg((body && typeof body.error === "string" && body.error) || fallback);
  }

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
    if (!r.ok) return reportError(r, "Failed to update paid status");
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
    if (!r.ok) return reportError(r, "Failed to update paid status");
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
    if (!r.ok) return reportError(r, "Failed to refresh — your last change may not be reflected yet");
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
    if (!r.ok) return reportError(r, "Failed to log payment");
    const created = await r.json();
    setEntries((cur) =>
      cur.map((e) => (e.id !== entryId ? e : { ...e, debtPayments: [created, ...e.debtPayments] }))
    );
  }

  async function undoDebtPayment(entryId: string, paymentId: string) {
    const r = await fetch(`/api/entries/${entryId}/debt-payments/${paymentId}`, { method: "DELETE" });
    if (!r.ok) return reportError(r, "Failed to undo payment");
    setEntries((cur) =>
      cur.map((e) =>
        e.id !== entryId ? e : { ...e, debtPayments: e.debtPayments.filter((p) => p.id !== paymentId) }
      )
    );
  }

  const income = useMemo(() => entries.filter((e) => e.type === "income"), [entries]);
  const expenses = useMemo(() => entries.filter((e) => e.type === "expense"), [entries]);
  const purchases = useMemo(() => entries.filter((e) => e.type === "purchase"), [entries]);
  // What actually applies to the selected month, so the category tables list
  // the same entries their header totals are summed from.
  const monthIncome = useMemo(
    () => income.filter((e) => activeIn(e, selectedMonth)),
    [income, selectedMonth]
  );
  const monthExpenses = useMemo(
    () => expenses.filter((e) => activeIn(e, selectedMonth)),
    [expenses, selectedMonth]
  );
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

    let carry = balanceAdjustment;
    return months.map((month) => {
      const inc = income.filter((e) => activeIn(e, month));
      const exp = expenses.filter((e) => activeIn(e, month));
      const gotPaid = (e: Entry) => e.payments.some((p) => p.month === month);
      // One-off entries are settled the month they're logged; recurring ones
      // only count once they're actually marked received / paid.
      const settled = (e: Entry) => e.frequency !== "monthly" || gotPaid(e);
      // Monthly bills track their source per-month via Payment.fromBalance;
      // one-off bills are settled at creation, so they use their own
      // sourceKind the same way purchases do.
      const fromBalance = (e: Entry) =>
        e.frequency === "monthly"
          ? e.payments.some((p) => p.month === month && p.fromBalance)
          : (e.sourceKind ?? "balance") === "balance";

      const expectedIncome = sumBy(inc);
      const receivedIncome = sumBy(inc, settled);
      const billsDue = sumBy(exp);
      const billsPaid = sumBy(exp, settled);
      const billsUnpaid = billsDue - billsPaid;
      const spentFromBalance = sumBy(exp, (e) => settled(e) && fromBalance(e));

      // Purchases are already-spent money — they hit the balance the month
      // they're logged, with no paid/unpaid state to track. Ones paid off
      // balance or put on a card never touched it, so they don't reduce it.
      const monthPurchases = purchases.filter((e) => bornIn(e) === month);
      const purchaseSpend = sumBy(
        monthPurchases,
        (e) => (e.sourceKind ?? "balance") === "balance"
      );
      const purchaseTotal = sumBy(monthPurchases);

      // Balance and Debt are tracked independently — a debt payment changes
      // what you owe (see the Debt card/table) but never touches this
      // month's cash balance, even when it's flagged "from balance".
      const carryIn = carry;
      const closing = carryIn + receivedIncome - spentFromBalance - purchaseSpend;
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
        purchaseTotal,
        closing,
        // What's genuinely free once this month's remaining bills are covered.
        available: closing - billsUnpaid,
      };
    });
  }, [income, expenses, purchases, startMonth, currentMonth, balanceAdjustment]);

  const monthRow = useMemo(
    () => ledger.find((r) => r.month === selectedMonth) ?? ledger[ledger.length - 1],
    [ledger, selectedMonth]
  );
  const balance = monthRow?.closing ?? 0;
  const monthlySurplus = monthRow?.available ?? 0;
  const expectedIncome = monthRow?.expectedIncome ?? 0;
  const totalIncome = monthRow?.receivedIncome ?? 0;
  const totalExpense = monthRow?.billsDue ?? 0;
  const totalPurchases = monthRow?.purchaseTotal ?? 0;
  // DTI reflects income capacity, not whether this month's paycheck has
  // been ticked "received" yet, so it's keyed off expected income.
  const dti = expectedIncome > 0 ? totalDebt / (expectedIncome * 12) : 0;
  const monthlyToDebt = Math.max(0, monthlySurplus * (payoutPct / 100));
  // The simulation below pays every debt's minimum on top of monthlyToDebt,
  // so the real monthly outlay is the two combined, not monthlyToDebt alone.
  const totalMinPayments = useMemo(
    () => debts.reduce((s, d) => s + (d.minPayment ?? 0), 0),
    [debts]
  );

  // Amortization simulation: minimums on every debt, extra rolls into the
  // target debt, freed minimums snowball forward, interest accrues monthly.
  const [whatIfExtra, setWhatIfExtra] = useState(0);
  const [showPlanDetails, setShowPlanDetails] = useState(false);

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

  async function addEntry(payload: { type: EntryType; label: string; amount: number; frequency: "once" | "monthly"; apr?: number; minPayment?: number; dueDay?: number; source?: PaySource; debtEntryId?: string; note?: string }) {
    setBusy(true);
    const r = await fetch("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!r.ok) return reportError(r, "Failed to add entry");
    const created: Entry = await r.json();
    setModalType(null);
    // Buying on a card also raises a charge on that debt server-side.
    if (payload.source === "debt") return refreshEntries();
    setEntries((cur) => [created, ...cur]);
  }

  async function deleteEntry(id: string) {
    const target = entries.find((e) => e.id === id);
    const chargedCount =
      target?.type === "debt" ? entries.filter((e) => e.debtEntryId === id).length : 0;
    const message =
      chargedCount > 0
        ? `${chargedCount} purchase${chargedCount === 1 ? "" : "s"}/bill${chargedCount === 1 ? "" : "s"} ${
            chargedCount === 1 ? "is" : "are"
          } charged to this debt. Deleting it will unlink ${chargedCount === 1 ? "that entry" : "those entries"} from it (they stay, but no longer show as "On card"). Continue?`
        : "Delete this entry?";
    if (!confirm(message)) return;
    const hadCharge = !!target?.debtEntryId;
    const r = await fetch(`/api/entries/${id}`, { method: "DELETE" });
    if (!r.ok) return reportError(r, "Failed to delete");
    // Deleting a card purchase drops its debt charge too.
    if (hadCharge) return refreshEntries();
    setEntries((cur) => cur.filter((e) => e.id !== id));
  }

  const [editEntry, setEditEntry] = useState<Entry | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  async function updateEntry(
    id: string,
    patch: { label: string; amount: number; note: string | null; apr?: number | null; minPayment?: number | null; dueDay?: number | null }
  ) {
    setEditBusy(true);
    const r = await fetch(`/api/entries/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    setEditBusy(false);
    if (!r.ok) return reportError(r, "Failed to save changes");
    const updated = await r.json();
    setEditEntry(null);
    setEntries((cur) => cur.map((e) => (e.id === id ? { ...e, ...updated } : e)));
  }

  const [adjustBalanceBusy, setAdjustBalanceBusy] = useState(false);

  // Lets someone correct the tracked balance to match reality (e.g. their
  // real bank balance) without having to log it as an Income entry. Stored
  // as a running offset folded into the ledger's starting carry, so it
  // shows up in every month from here on rather than just one.
  async function adjustBalanceTo(newBalance: number) {
    const delta = newBalance - balance;
    const nextAdjustment = balanceAdjustment + delta;
    setAdjustBalanceBusy(true);
    const r = await fetch("/api/settings/balance", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balanceAdjustment: nextAdjustment }),
    });
    setAdjustBalanceBusy(false);
    if (!r.ok) return reportError(r, "Failed to update balance");
    const updated = await r.json();
    setBalanceAdjustment(updated.balanceAdjustment);
    setAdjustBalanceOpen(false);
  }

  const suggestions = buildSuggestions({
    fmt,
    totalIncome,
    expectedIncome,
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
    <CurrencyContext.Provider value={fmt}>
    <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      {isOffline && (
        <div
          role="status"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] max-w-md w-[calc(100%-2rem)] bg-red-400/15 border border-red-400/40 text-red-200 rounded-xl px-4 py-3 shadow-2xl text-sm text-center"
        >
          You're offline — changes won't save until your connection comes back.
        </div>
      )}
      {errorMsg && (
        <div
          role="alert"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] max-w-md w-[calc(100%-2rem)] bg-rose-500/15 border border-rose-500/40 text-rose-200 rounded-xl px-4 py-3 shadow-2xl flex items-start gap-3"
        >
          <span className="flex-1 text-sm">{errorMsg}</span>
          <button
            onClick={() => setErrorMsg(null)}
            aria-label="Dismiss"
            className="text-rose-300 hover:text-white shrink-0"
          >
            ✕
          </button>
        </div>
      )}
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">
            Hello, <span className="text-red-400">{userName || userEmail.split("@")[0]}</span>
          </h1>
          <p className="text-neutral-400 text-sm">Your money, tracked.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-neutral-900/60 border border-neutral-800 rounded-xl px-1 py-1">
            <button
              onClick={() => setSelectedMonth((m) => shiftMonth(m, -1))}
              disabled={selectedMonth <= startMonth}
              className="px-2 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 disabled:hover:bg-transparent"
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
              className="px-2 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 disabled:hover:bg-transparent"
              title="Next month"
            >
              ›
            </button>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
            className="p-2.5 rounded-xl border border-neutral-700 hover:bg-neutral-800 transition text-neutral-300 hover:text-white"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="px-4 py-2 rounded-xl border border-neutral-700 hover:bg-neutral-800 transition text-sm whitespace-nowrap"
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
          accent={balance >= 0 ? "red" : "rose"}
          sub={
            monthRow && monthRow.carryIn !== 0
              ? `${fmt(monthRow.carryIn)} carried in`
              : "Left at end of this month"
          }
          onEdit={() => setAdjustBalanceOpen(true)}
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
          accent="crimson"
          sub={
            monthRow && monthRow.purchaseTotal > monthRow.purchaseSpend
              ? `${fmt(monthRow.purchaseTotal - monthRow.purchaseSpend)} not from balance`
              : "Spent this month"
          }
        />
        <StatCard label="Debt" value={fmt(totalDebt)} accent="maroon" />
        <div className="col-span-2 md:col-span-1">
          <StatCard
            label="Free to spend"
            value={fmt(monthlySurplus)}
            accent={monthlySurplus >= 0 ? "highlight" : "rose"}
            sub={
              monthRow && monthRow.billsUnpaid > 0
                ? `After ${fmt(monthRow.billsUnpaid)} of bills left`
                : "Bills covered — all yours"
            }
          />
        </div>
      </section>

      {monthRow && monthRow.expectedIncome > monthRow.receivedIncome && (
        <p className="text-sm text-red-300 bg-red-400/10 border border-red-400/25 rounded-xl px-4 py-2.5">
          {fmt(monthRow.expectedIncome - monthRow.receivedIncome)} income not received yet — mark it
          received in the Income table once it lands.
        </p>
      )}

      {milestone && (
        <section
          className={`rounded-2xl border p-4 flex items-center gap-4 ${
            milestone.pct === 100
              ? "bg-red-500/15 border-red-500/40"
              : "bg-red-500/10 border-red-500/25"
          }`}
        >
          <span className="text-3xl">{milestone.pct === 100 ? "🏆" : "🎯"}</span>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-red-300">{milestone.pct === 100 ? "Debt-free!" : `${milestone.pct}% paid off`}</p>
            <p className="text-sm text-neutral-300">{milestone.msg}</p>
            <div className="mt-2 h-2 w-full bg-neutral-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-red-500 rounded-full transition-all"
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
          color="red"
          rows={monthIncome}
          total={totalIncome}
          onAdd={() => setModalType("income")}
          onDelete={deleteEntry}
          onEdit={setEditEntry}
          selectedMonth={selectedMonth}
          onTogglePaid={(id, paid) => toggleReceived(id, paid)}
          payBusy={payBusy}
          paidLabels={{ header: "Got it", yes: "✓ Received", no: "Mark received" }}
        />
        <CategoryTable
          title="Bills"
          color="rose"
          rows={monthExpenses}
          total={totalExpense}
          onAdd={() => setModalType("expense")}
          onDelete={deleteEntry}
          onEdit={setEditEntry}
          selectedMonth={selectedMonth}
          onTogglePaid={togglePaid}
          payBusy={payBusy}
        />
        <CategoryTable
          title="Purchases"
          color="crimson"
          rows={purchases.filter((e) => monthKey(new Date(e.createdAt)) === selectedMonth)}
          total={totalPurchases}
          onAdd={() => setModalType("purchase")}
          onDelete={deleteEntry}
          onEdit={setEditEntry}
        />
        <CategoryTable
          title="Debt"
          color="maroon"
          rows={debts}
          total={totalDebt}
          onAdd={() => setModalType("debt")}
          onDelete={deleteEntry}
          onEdit={(d) => setEditEntry({ ...d, amount: d.originalAmount ?? d.amount })}
          showShare
          onLogPayment={(id, label) => setDebtModal({ id, label })}
        />
      </section>

      {/* Summary table */}
      <section className="bg-neutral-900/60 border border-neutral-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-800 flex items-center justify-between">
          <h2 className="text-lg font-bold">Monthly summary</h2>
          <span className="text-xs text-neutral-500">All numbers combined</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-neutral-400 text-xs uppercase">
            <tr>
              <th className="text-left px-5 py-3">Category</th>
              <th className="text-right px-5 py-3">Entries</th>
              <th className="text-right px-5 py-3">Total</th>
              <th className="text-right px-5 py-3 hidden sm:table-cell">% of Income</th>
              <th className="text-left px-5 py-3 hidden md:table-cell">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            <SumRow label="Income" count={monthIncome.length} total={totalIncome} pctOfIncome={1} color="red" />
            <SumRow
              label="Bills"
              count={monthExpenses.length}
              total={-totalExpense}
              pctOfIncome={totalIncome ? -totalExpense / totalIncome : 0}
              color="rose"
            />
            <SumRow
              label="Purchases"
              count={purchases.filter((e) => monthKey(new Date(e.createdAt)) === selectedMonth).length}
              total={-totalPurchases}
              pctOfIncome={totalIncome ? -totalPurchases / totalIncome : 0}
              color="crimson"
            />
            <SumRow
              label="Debt"
              count={debts.length}
              total={-totalDebt}
              pctOfIncome={totalIncome ? -totalDebt / totalIncome : 0}
              color="maroon"
              note={`DTI ratio ${pct(dti)}`}
            />
            <tr className="bg-neutral-900/80 font-bold">
              <td className="px-5 py-3">Net balance</td>
              <td className="px-5 py-3 text-right text-neutral-400">{entries.length}</td>
              <td className={`px-5 py-3 text-right tabular-nums ${balance >= 0 ? "text-red-400" : "text-rose-400"}`}>
                {fmt(balance)}
              </td>
              <td className="px-5 py-3 text-right hidden sm:table-cell text-neutral-400">
                {totalIncome ? pct(balance / totalIncome) : "—"}
              </td>
              <td className="px-5 py-3 hidden md:table-cell text-neutral-500">
                Income − Bills − Purchases (debt is tracked separately, not netted in)
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Debt payment plan */}
      <section className="bg-gradient-to-br from-rose-700/10 via-neutral-900 to-neutral-900 border border-rose-700/30 rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2">
              <span>Debt payment plan</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-rose-700/20 text-rose-400 border border-rose-700/40">
                Smart plan
              </span>
            </h2>
            <p className="text-neutral-400 text-sm">
              Driven by what's <span className="text-white">free after this month's bills</span> ({fmt(monthlySurplus)}).
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex bg-neutral-800 border border-neutral-700 rounded-xl p-1">
              <button
                onClick={() => setStrategy("avalanche")}
                className={`px-3 py-1.5 rounded-lg text-sm transition ${
                  strategy === "avalanche" ? "bg-rose-700 text-neutral-950 font-semibold" : "text-neutral-300"
                }`}
              >
                Avalanche
              </button>
              <button
                onClick={() => setStrategy("snowball")}
                className={`px-3 py-1.5 rounded-lg text-sm transition ${
                  strategy === "snowball" ? "bg-rose-700 text-neutral-950 font-semibold" : "text-neutral-300"
                }`}
              >
                Snowball
              </button>
            </div>
          </div>
        </div>

        {plan.monthsToClear !== Infinity && altPlan.monthsToClear !== Infinity && debts.length > 1 &&
          Math.abs(plan.totalInterest - altPlan.totalInterest) >= 1 && (
          <p className="text-xs text-neutral-400 -mt-2 mb-4">
            {plan.totalInterest <= altPlan.totalInterest ? (
              <>
                <span className="text-red-300 font-semibold capitalize">{strategy}</span> saves{" "}
                <span className="text-red-300">{fmt(altPlan.totalInterest - plan.totalInterest)}</span> in interest
                {altPlan.monthsToClear > plan.monthsToClear &&
                  ` and ${altPlan.monthsToClear - plan.monthsToClear} month${altPlan.monthsToClear - plan.monthsToClear === 1 ? "" : "s"}`}{" "}
                vs {strategy === "avalanche" ? "snowball" : "avalanche"}.
              </>
            ) : (
              <>
                Switching to{" "}
                <span className="text-rose-400 font-semibold">{strategy === "avalanche" ? "snowball" : "avalanche"}</span>{" "}
                would save <span className="text-rose-400">{fmt(plan.totalInterest - altPlan.totalInterest)}</span> in interest.
              </>
            )}
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <MiniStat
            label="Total to debt / mo"
            value={fmt(monthlyToDebt + totalMinPayments)}
            sub={totalMinPayments > 0 ? `${fmt(totalMinPayments)} minimums + ${fmt(monthlyToDebt)} extra` : undefined}
          />
          <MiniStat
            label="Debt-free date"
            value={monthsToClear === Infinity ? "∞" : monthsToClear === 0 ? "Now" : monthLabel(monthsToClear)}
          />
          <MiniStat
            label="Interest you'll pay"
            value={plan.totalInterest === Infinity ? "∞" : fmt(plan.totalInterest)}
          />
          <div className="bg-neutral-900/70 border border-neutral-800 rounded-xl p-3">
            <p className="text-xs uppercase tracking-wider text-neutral-500">Surplus % to debt</p>
            <div className="flex items-center gap-3 mt-2">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={payoutPct}
                onChange={(e) => setPayoutPct(parseInt(e.target.value))}
                className="flex-1 min-w-0 accent-rose-700"
              />
              <span className="text-rose-400 font-semibold shrink-0 text-right tabular-nums">{payoutPct}%</span>
            </div>
          </div>
        </div>

        {debts.length > 0 && (
          <>
            <button
              onClick={() => setShowPlanDetails((v) => !v)}
              className="text-sm text-neutral-400 hover:text-white mb-5 flex items-center gap-1.5"
            >
              <span className={`transition-transform ${showPlanDetails ? "rotate-90" : ""}`}>›</span>
              {showPlanDetails ? "Hide" : "Show"} chart &amp; "what if" calculator
            </button>
            {showPlanDetails && (
              <div className="grid md:grid-cols-2 gap-3 mb-5">
                <div className="bg-neutral-900/70 border border-neutral-800 rounded-xl p-3">
                  <p className="text-xs uppercase tracking-wider text-neutral-500 mb-2">
                    What if I paid more each month?
                  </p>
                  <div className="flex items-center gap-3">
                    <span className="text-neutral-400 text-sm">+</span>
                    <input
                      type="number"
                      min={0}
                      step={10}
                      value={whatIfExtra || ""}
                      placeholder="0"
                      onChange={(e) => setWhatIfExtra(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="w-24 px-3 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 focus:border-rose-700 outline-none text-sm tabular-nums"
                    />
                    <span className="text-neutral-400 text-sm">/mo extra</span>
                  </div>
                  {whatIfPlan && plan.monthsToClear !== Infinity && whatIfPlan.monthsToClear !== Infinity && (
                    <p className="text-sm mt-2 text-red-300">
                      Debt-free {plan.monthsToClear - whatIfPlan.monthsToClear} month
                      {plan.monthsToClear - whatIfPlan.monthsToClear === 1 ? "" : "s"} sooner, save{" "}
                      {fmt(Math.max(0, plan.totalInterest - whatIfPlan.totalInterest))} in interest.
                    </p>
                  )}
                  {whatIfPlan && plan.monthsToClear === Infinity && whatIfPlan.monthsToClear !== Infinity && (
                    <p className="text-sm mt-2 text-red-300">
                      That extra makes you debt-free in {whatIfPlan.monthsToClear} months — right now you never get there.
                    </p>
                  )}
                </div>
                <div className="bg-neutral-900/70 border border-neutral-800 rounded-xl p-3">
                  <p className="text-xs uppercase tracking-wider text-neutral-500 mb-1">Balance over time</p>
                  {plan.monthsToClear === Infinity ? (
                    <p className="text-sm text-neutral-500 italic mt-2">
                      Payments don't cover interest — balance never reaches zero. Raise the slider.
                    </p>
                  ) : (
                    <PayoffChart timeline={(whatIfPlan ?? plan).timeline} />
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {debts.length === 0 ? (
          <p className="text-neutral-400 italic">No debts logged. Hit "+ Debt" to start planning.</p>
        ) : (
          <div className="overflow-x-auto bg-neutral-900/60 border border-neutral-800 rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-neutral-400 text-xs uppercase">
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
              <tbody className="divide-y divide-neutral-800">
                {payoffOrder.map((d, i) => (
                  <tr key={d.id} className="hover:bg-rose-700/5">
                    <td className="px-4 py-3 text-neutral-500">{i + 1}</td>
                    <td className="px-4 py-3 font-medium">
                      {d.label}
                      {i === 0 && (
                        <span className="ml-2 text-xs px-2 py-0.5 rounded bg-rose-700/20 text-rose-400">
                          attack first
                        </span>
                      )}
                      {(d.originalAmount ?? 0) > 0 && (
                        <div className="mt-1.5 h-1.5 w-full max-w-[160px] bg-neutral-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-red-500 rounded-full"
                            style={{
                              width: `${Math.min(100, Math.max(0, (1 - d.amount / Math.max(d.originalAmount ?? d.amount, d.amount)) * 100))}%`,
                            }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-rose-400">{fmt(d.amount)}</td>
                    <td className="px-4 py-3 text-right hidden sm:table-cell text-neutral-400 tabular-nums">
                      {d.apr != null ? `${d.apr}%` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right hidden lg:table-cell text-rose-300/80 tabular-nums">
                      {d.interest > 0 ? fmt(d.interest) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {d.months === Infinity ? "∞" : `${d.months} mo`}
                    </td>
                    <td className="px-4 py-3 text-right hidden md:table-cell text-neutral-400">
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
                    ? "bg-neutral-500/10 border-neutral-500/30"
                    : s.tone === "warn"
                    ? "bg-red-400/10 border-red-400/30"
                    : "bg-rose-500/10 border-rose-500/30"
                }`}
              >
                <p className="font-semibold text-white">{s.title}</p>
                <p className="text-sm text-neutral-300 mt-1">{s.body}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {modalType && (
        <EntryModal
          type={modalType}
          debts={debts.map((d) => ({ id: d.id, label: d.label, amount: d.amount }))}
          onClose={() => setModalType(null)}
          onSubmit={addEntry}
          busy={busy}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          currency={currency}
          currentBalance={balance}
          onClose={() => setSettingsOpen(false)}
          onSaved={(code) => {
            setCurrency(code);
            setSettingsOpen(false);
          }}
          onBanksChanged={refreshEntries}
          onApplyBalance={adjustBalanceTo}
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

      {editEntry && (
        <EditEntryModal
          entry={editEntry}
          busy={editBusy}
          onClose={() => setEditEntry(null)}
          onSubmit={(patch) => updateEntry(editEntry.id, patch)}
        />
      )}

      {adjustBalanceOpen && (
        <AdjustBalanceModal
          currentBalance={balance}
          busy={adjustBalanceBusy}
          onClose={() => setAdjustBalanceOpen(false)}
          onSave={adjustBalanceTo}
        />
      )}
    </main>
    </CurrencyContext.Provider>
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
  onEdit,
  showShare,
  selectedMonth,
  onTogglePaid,
  payBusy,
  onLogPayment,
  paidLabels,
}: {
  title: string;
  color: "red" | "rose" | "maroon" | "crimson";
  rows: Entry[];
  total: number;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onEdit: (entry: Entry) => void;
  showShare?: boolean;
  selectedMonth?: string;
  onTogglePaid?: (id: string, paid: boolean, label: string, amount: number) => void;
  payBusy?: string | null;
  onLogPayment?: (id: string, label: string) => void;
  paidLabels?: { header: string; yes: string; no: string };
}) {
  const fmt = useContext(CurrencyContext);
  const marks = paidLabels ?? { header: "Paid", yes: "✓ Paid", no: "Mark paid" };
  const map = {
    red: { bar: "bg-red-500", text: "text-red-400", chip: "bg-red-500/15 border-red-500/30", btn: "bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 shadow-md shadow-red-950/40" },
    rose: { bar: "bg-rose-500", text: "text-rose-400", chip: "bg-rose-500/15 border-rose-500/30", btn: "bg-gradient-to-b from-rose-500 to-rose-600 hover:to-rose-500 text-white shadow-md shadow-rose-950/40" },
    maroon: { bar: "bg-rose-700", text: "text-rose-600", chip: "bg-rose-700/15 border-rose-700/30", btn: "bg-gradient-to-b from-rose-700 to-rose-800 hover:to-rose-700 text-neutral-950 shadow-md shadow-rose-950/40" },
    crimson: { bar: "bg-red-600", text: "text-red-500", chip: "bg-red-600/15 border-red-600/30", btn: "bg-gradient-to-b from-red-600 to-red-700 hover:to-red-600 text-white shadow-md shadow-red-950/40" },
  }[color];
  return (
    <div className="bg-neutral-900/60 border border-neutral-800 rounded-2xl overflow-hidden flex flex-col">
      <div className={`h-1 ${map.bar}`} />
      <div className="px-5 py-4 flex items-center justify-between border-b border-neutral-800">
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
          <thead className="text-neutral-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">Label</th>
              <th className="text-right px-4 py-2">Amount</th>
              {showShare && <th className="text-right px-4 py-2">Share</th>}
              {onTogglePaid && <th className="text-center px-4 py-2">{marks.header}</th>}
              <th className="px-4 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.length === 0 && (
              <tr>
                <td colSpan={(showShare ? 4 : 3) + (onTogglePaid ? 1 : 0)} className="text-center py-8 text-neutral-500 italic">
                  Empty — click + Add
                </td>
              </tr>
            )}
            {rows.map((e) => {
              const paid = !!selectedMonth && e.payments.some((p) => p.month === selectedMonth);
              return (
              <tr key={e.id} className={`hover:bg-neutral-800/40 ${paid ? "bg-red-500/5" : ""}`}>
                <td className="px-4 py-2.5">
                  <p className="font-medium truncate flex items-center gap-2">
                    {e.label}
                    {e.type === "purchase" ? (
                      <>
                        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                          {new Date(e.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                        {e.sourceKind === "debt" && (
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-700/20 text-rose-400 border border-rose-700/30">
                            On card
                          </span>
                        )}
                        {e.sourceKind === "off" && (
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-neutral-700/50 text-neutral-400 border border-neutral-600/40">
                            Off balance
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <span
                          className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                            e.frequency === "monthly"
                              ? "bg-neutral-400/20 text-white border border-neutral-400/30"
                              : "bg-neutral-700/50 text-neutral-400 border border-neutral-600/40"
                          }`}
                        >
                          {e.frequency === "monthly" ? "Monthly" : "Once"}
                        </span>
                        {e.sourceKind === "debt" && (
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-700/20 text-rose-400 border border-rose-700/30">
                            On card
                          </span>
                        )}
                        {e.sourceKind === "off" && (
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-neutral-700/50 text-neutral-400 border border-neutral-600/40">
                            Off balance
                          </span>
                        )}
                      </>
                    )}
                    {onLogPayment &&
                      e.dueDay != null &&
                      e.amount > 0 &&
                      daysUntilDue(e.dueDay) <= 7 &&
                      !paidSinceLastDue(e.dueDay, e.debtPayments) && (
                      <span
                        className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                          daysUntilDue(e.dueDay) === 0
                            ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                            : "bg-red-400/20 text-red-300 border-red-400/40"
                        }`}
                      >
                        {daysUntilDue(e.dueDay) === 0 ? "Due today" : `Due in ${daysUntilDue(e.dueDay)}d`}
                      </span>
                    )}
                  </p>
                  {e.note && <p className="text-xs text-neutral-500 truncate">{e.note}</p>}
                  {onLogPayment && (!!e.paidSoFar || !!e.chargedSoFar) && (
                    <p className="text-xs text-neutral-500 truncate">
                      {fmt(e.paidSoFar ?? 0)} paid
                      {e.chargedSoFar ? ` · ${fmt(e.chargedSoFar)} used` : ""} · started {fmt(e.originalAmount ?? e.amount)}
                    </p>
                  )}
                </td>
                <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${map.text}`}>
                  {fmt(e.amount)}
                </td>
                {showShare && (
                  <td className="px-4 py-2.5 text-right text-neutral-400 tabular-nums">
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
                            ? "bg-red-500/20 border-red-500/40 text-red-300"
                            : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white"
                        }`}
                      >
                        {paid
                          ? e.payments.find((p) => p.month === selectedMonth)?.debtEntryId
                            ? "✓ On card"
                            : marks.yes
                          : marks.no}
                      </button>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </td>
                )}
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {onLogPayment && (
                      <button
                        onClick={() => onLogPayment(e.id, e.label)}
                        className="px-2 py-1 rounded-lg text-xs font-semibold bg-rose-700/15 border border-rose-700/30 text-rose-400 hover:bg-rose-700/25"
                      >
                        + Payment
                      </button>
                    )}
                    <button
                      onClick={() => onEdit(e)}
                      className="text-neutral-500 hover:text-red-400"
                      title="Edit"
                      aria-label={`Edit ${e.label}`}
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => onDelete(e.id)}
                      className="text-neutral-500 hover:text-rose-400"
                      title="Delete"
                      aria-label={`Delete ${e.label}`}
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
  onEdit,
}: {
  label: string;
  value: string;
  accent: "red" | "rose" | "maroon" | "highlight" | "crimson";
  sub?: string;
  onEdit?: () => void;
}) {
  const colors: Record<string, string> = {
    red: "from-red-500/20 to-red-500/0 border-red-500/30",
    rose: "from-rose-500/20 to-rose-500/0 border-rose-500/30",
    maroon: "from-rose-700/20 to-rose-700/0 border-rose-700/30",
    highlight: "from-neutral-400/20 to-neutral-400/0 border-neutral-400/30",
    crimson: "from-red-600/20 to-red-600/0 border-red-600/30",
  };
  return (
    <div className={`relative bg-gradient-to-br ${colors[accent]} border rounded-2xl p-4`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs uppercase tracking-wider opacity-80">{label}</p>
        {onEdit && (
          <button
            onClick={onEdit}
            title={`Edit ${label.toLowerCase()}`}
            aria-label={`Edit ${label.toLowerCase()}`}
            className="text-neutral-400 hover:text-white -mt-1 -mr-1 p-1"
          >
            ✎
          </button>
        )}
      </div>
      <p className="text-2xl font-bold mt-2 tabular-nums text-white">{value}</p>
      {sub && <p className="text-xs text-neutral-400 mt-1">{sub}</p>}
    </div>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-neutral-900/70 border border-neutral-800 rounded-xl p-3">
      <p className="text-xs uppercase tracking-wider text-neutral-500">{label}</p>
      <p className="text-xl font-bold tabular-nums mt-1">{value}</p>
      {sub && <p className="text-[11px] text-neutral-500 mt-0.5">{sub}</p>}
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
  color: "red" | "rose" | "maroon" | "crimson";
  note?: string;
}) {
  const fmt = useContext(CurrencyContext);
  const map = {
    red: "text-red-400",
    rose: "text-rose-400",
    maroon: "text-rose-600",
    crimson: "text-red-500",
  };
  return (
    <tr className="hover:bg-neutral-800/30">
      <td className="px-5 py-3 font-medium">{label}</td>
      <td className="px-5 py-3 text-right text-neutral-400">{count}</td>
      <td className={`px-5 py-3 text-right tabular-nums font-semibold ${map[color]}`}>{fmt(total)}</td>
      <td className="px-5 py-3 text-right hidden sm:table-cell text-neutral-400">{pct(pctOfIncome)}</td>
      <td className="px-5 py-3 hidden md:table-cell text-neutral-500">{note ?? ""}</td>
    </tr>
  );
}

function SourcePicker({
  source,
  setSource,
  debts,
  debtEntryId,
  setDebtEntryId,
}: {
  source: PaySource;
  setSource: (s: PaySource) => void;
  debts: { id: string; label: string; amount: number }[];
  debtEntryId: string;
  setDebtEntryId: (id: string) => void;
}) {
  const fmt = useContext(CurrencyContext);
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-neutral-400 mb-2">Paid with</label>
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => setSource("balance")}
          className={`px-2 py-2.5 rounded-xl border text-sm font-medium transition ${
            source === "balance"
              ? "bg-red-500/20 border-red-500 text-red-200"
              : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white"
          }`}
        >
          Balance
        </button>
        <button
          type="button"
          onClick={() => setSource("off")}
          className={`px-2 py-2.5 rounded-xl border text-sm font-medium transition ${
            source === "off"
              ? "bg-neutral-600/40 border-neutral-500 text-white"
              : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white"
          }`}
        >
          Off balance
        </button>
        <button
          type="button"
          disabled={debts.length === 0}
          onClick={() => setSource("debt")}
          className={`px-2 py-2.5 rounded-xl border text-sm font-medium transition disabled:opacity-40 ${
            source === "debt"
              ? "bg-rose-700/20 border-rose-700 text-rose-300"
              : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white"
          }`}
        >
          Card
        </button>
      </div>
      <p className="text-xs text-neutral-500 mt-2">
        {source === "balance"
          ? "Comes straight out of your balance."
          : source === "off"
          ? "Paid with untracked money — balance unaffected."
          : "Added to what you owe on the card — balance unaffected."}
      </p>
      {source === "debt" && (
        <select
          value={debtEntryId}
          onChange={(e) => setDebtEntryId(e.target.value)}
          className="w-full mt-2 px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-rose-700 outline-none"
        >
          <option value="">Choose a card or loan…</option>
          {debts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label} — {fmt(d.amount)} owed
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function EntryModal({
  type,
  onClose,
  onSubmit,
  busy,
  debts,
}: {
  type: EntryType;
  debts: { id: string; label: string; amount: number }[];
  onClose: () => void;
  onSubmit: (p: { type: EntryType; label: string; amount: number; frequency: "once" | "monthly"; apr?: number; minPayment?: number; dueDay?: number; source?: PaySource; debtEntryId?: string; note?: string }) => void;
  busy: boolean;
}) {
  useEscapeClose(onClose);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [apr, setApr] = useState("");
  const [minPayment, setMinPayment] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [source, setSource] = useState<PaySource>("balance");
  const [debtEntryId, setDebtEntryId] = useState("");
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

  // One-off bills are settled the moment they're logged, same as purchases,
  // so they need the same "where did this come from" answer.
  const tracksSource = type === "purchase" || (type === "expense" && frequency === "once");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = parseFloat(amount);
    if (!label.trim() || isNaN(n) || n <= 0) return;
    const aprN = parseFloat(apr);
    const minN = parseFloat(minPayment);
    const dueN = parseInt(dueDay);
    if (tracksSource && source === "debt" && !debtEntryId) return;
    onSubmit({
      type,
      label: label.trim(),
      amount: n,
      frequency,
      source: tracksSource ? source : undefined,
      debtEntryId: tracksSource && source === "debt" ? debtEntryId : undefined,
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
        role="dialog"
        aria-modal="true"
        aria-label={titles[type]}
        className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-md shadow-2xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold capitalize">{titles[type]}</h2>
          <button onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white">✕</button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {type === "purchase" ? (
            <SourcePicker
              source={source}
              setSource={setSource}
              debts={debts}
              debtEntryId={debtEntryId}
              setDebtEntryId={setDebtEntryId}
            />
          ) : (
          <div>
            <label className="block text-xs uppercase tracking-wider text-neutral-400 mb-2">Frequency</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFrequency("once")}
                className={`px-3 py-2.5 rounded-xl border text-sm font-medium transition ${
                  frequency === "once"
                    ? "bg-neutral-700 border-neutral-500 text-white"
                    : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white"
                }`}
              >
                One-time
              </button>
              <button
                type="button"
                onClick={() => setFrequency("monthly")}
                className={`px-3 py-2.5 rounded-xl border text-sm font-medium transition ${
                  frequency === "monthly"
                    ? "bg-neutral-400/20 border-neutral-400 text-white"
                    : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white"
                }`}
              >
                Monthly recurring
              </button>
            </div>
            <p className="text-xs text-neutral-500 mt-2">{hints[type][frequency]}</p>
          </div>
          )}
          {type === "expense" && frequency === "once" && (
            <SourcePicker
              source={source}
              setSource={setSource}
              debts={debts}
              debtEntryId={debtEntryId}
              setDebtEntryId={setDebtEntryId}
            />
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
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
          />
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
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
                className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-rose-700 outline-none"
              />
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="Min payment / mo"
                value={minPayment}
                onChange={(e) => setMinPayment(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-rose-700 outline-none"
              />
              <input
                type="number"
                step="1"
                min="1"
                max="31"
                placeholder="Due day (1–31)"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
                className="col-span-2 w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-rose-700 outline-none"
              />
              <p className="col-span-2 text-xs text-neutral-500">
                APR + minimum make the payoff plan accurate; due day shows a reminder before the payment date.
              </p>
            </div>
          )}
          <textarea
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none resize-none"
          />
          <button
            disabled={busy}
            className="w-full py-3 rounded-xl bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 font-semibold shadow-lg shadow-red-950/50 disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </form>
      </div>
    </div>
  );
}

function EditEntryModal({
  entry,
  busy,
  onClose,
  onSubmit,
}: {
  entry: Entry;
  busy: boolean;
  onClose: () => void;
  onSubmit: (patch: { label: string; amount: number; note: string | null; apr?: number | null; minPayment?: number | null; dueDay?: number | null }) => void;
}) {
  useEscapeClose(onClose);
  const isDebt = entry.type === "debt";
  const [label, setLabel] = useState(entry.label);
  const [amount, setAmount] = useState(String(entry.amount));
  const [note, setNote] = useState(entry.note ?? "");
  const [apr, setApr] = useState(entry.apr != null ? String(entry.apr) : "");
  const [minPayment, setMinPayment] = useState(entry.minPayment != null ? String(entry.minPayment) : "");
  const [dueDay, setDueDay] = useState(entry.dueDay != null ? String(entry.dueDay) : "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = parseFloat(amount);
    if (!label.trim() || isNaN(n) || n <= 0) return;
    const aprN = parseFloat(apr);
    const minN = parseFloat(minPayment);
    const dueN = parseInt(dueDay);
    onSubmit({
      label: label.trim(),
      amount: n,
      note: note.trim() || null,
      apr: isDebt ? (!isNaN(aprN) && aprN >= 0 ? aprN : null) : undefined,
      minPayment: isDebt ? (!isNaN(minN) && minN > 0 ? minN : null) : undefined,
      dueDay: isDebt ? (!isNaN(dueN) && dueN >= 1 && dueN <= 31 ? dueN : null) : undefined,
    });
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm grid place-items-center z-50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${entry.label}`}
        className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-md shadow-2xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Edit {entry.type === "debt" ? "debt" : entry.type}</h2>
          <button onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white">✕</button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
          />
          <div>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
            />
            {isDebt && (
              <p className="text-xs text-neutral-500 mt-2">
                This is the starting balance the payoff plan measures progress against — editing it
                doesn't change what's currently owed; log a payment or card usage for that.
              </p>
            )}
          </div>
          {isDebt && (
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="APR % (optional)"
                value={apr}
                onChange={(e) => setApr(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-rose-700 outline-none"
              />
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="Min payment / mo"
                value={minPayment}
                onChange={(e) => setMinPayment(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-rose-700 outline-none"
              />
              <input
                type="number"
                step="1"
                min="1"
                max="31"
                placeholder="Due day (1–31)"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
                className="col-span-2 w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-rose-700 outline-none"
              />
            </div>
          )}
          <textarea
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none resize-none"
          />
          <button
            disabled={busy}
            className="w-full py-3 rounded-xl bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 font-semibold shadow-lg shadow-red-950/50 disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save changes"}
          </button>
        </form>
      </div>
    </div>
  );
}

function AdjustBalanceModal({
  currentBalance,
  busy,
  onClose,
  onSave,
}: {
  currentBalance: number;
  busy: boolean;
  onClose: () => void;
  onSave: (newBalance: number) => void;
}) {
  useEscapeClose(onClose);
  const fmt = useContext(CurrencyContext);
  const [value, setValue] = useState(currentBalance.toFixed(2));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = parseFloat(value);
    if (isNaN(n)) return;
    onSave(n);
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm grid place-items-center z-50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Adjust balance"
        className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-md shadow-2xl"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-bold">Adjust balance</h2>
          <button onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white">✕</button>
        </div>
        <p className="text-neutral-400 text-sm mb-4">
          Set your balance to match reality — e.g. your real bank balance — without logging it as
          income. Currently {fmt(currentBalance)}.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <input
            autoFocus
            type="number"
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none text-lg tabular-nums"
          />
          <button
            disabled={busy}
            className="w-full py-3 rounded-xl bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 font-semibold shadow-lg shadow-red-950/50 disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save balance"}
          </button>
        </form>
      </div>
    </div>
  );
}

function SettingsModal({
  currency,
  currentBalance,
  onClose,
  onSaved,
  onBanksChanged,
  onApplyBalance,
}: {
  currency: string;
  currentBalance: number;
  onClose: () => void;
  onSaved: (code: string) => void;
  onBanksChanged: () => void;
  onApplyBalance: (newBalance: number) => void;
}) {
  useEscapeClose(onClose);
  const [tab, setTab] = useState<"currency" | "bank" | "password">("currency");
  const [picked, setPicked] = useState(currency);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

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
    setError(null);
    const r = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currency: picked }),
    });
    setBusy(false);
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      return setError(body?.error ?? "Failed to save currency");
    }
    onSaved(picked);
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(false);
    if (newPassword.length < 6) return setPwError("New password must be at least 6 characters");
    if (newPassword !== confirmPassword) return setPwError("New passwords don't match");
    setPwBusy(true);
    const r = await fetch("/api/settings/password", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    setPwBusy(false);
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      return setPwError(body?.error ?? "Failed to change password");
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPwSuccess(true);
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm grid place-items-center z-50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[85vh]"
      >
        <div className="p-6 pb-3 shrink-0">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-bold">Settings</h2>
            <button onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white text-lg leading-none p-1">✕</button>
          </div>
          <div className="flex bg-neutral-800 border border-neutral-700 rounded-xl p-1">
            <button
              onClick={() => setTab("currency")}
              className={`flex-1 px-3 py-1.5 rounded-lg text-sm transition ${
                tab === "currency" ? "bg-red-500 text-neutral-950 font-semibold" : "text-neutral-300"
              }`}
            >
              Currency
            </button>
            <button
              onClick={() => setTab("bank")}
              className={`flex-1 px-3 py-1.5 rounded-lg text-sm transition ${
                tab === "bank" ? "bg-red-500 text-neutral-950 font-semibold" : "text-neutral-300"
              }`}
            >
              Bank
            </button>
            <button
              onClick={() => setTab("password")}
              className={`flex-1 px-3 py-1.5 rounded-lg text-sm transition ${
                tab === "password" ? "bg-red-500 text-neutral-950 font-semibold" : "text-neutral-300"
              }`}
            >
              Password
            </button>
          </div>
        </div>

        {tab === "currency" ? (
          <>
            <div className="px-6 pb-3 shrink-0">
              <p className="text-neutral-400 text-sm mb-4">
                Everything is displayed in {currencySymbol(picked)} {picked}.
              </p>
              <input
                autoFocus
                placeholder="Search currency (e.g. euro, CAD)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
              />
            </div>

            <div className="flex-1 overflow-y-auto px-6 space-y-1 min-h-0">
              {shown.length === 0 && <p className="text-sm text-neutral-500 italic py-4">No currency matches that.</p>}
              {shown.map((o) => (
                <button
                  key={o.code}
                  onClick={() => setPicked(o.code)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition flex items-center gap-3 ${
                    picked === o.code
                      ? "bg-red-500/15 border-red-500/50"
                      : "bg-neutral-800/60 border-neutral-700/60 hover:border-neutral-600"
                  }`}
                >
                  <span className="w-12 shrink-0 font-semibold tabular-nums text-neutral-300">{o.symbol}</span>
                  <span className="flex-1 min-w-0">
                    <span className="font-medium">{o.code}</span>
                    <span className="block text-xs text-neutral-500 truncate">{o.name}</span>
                  </span>
                  {picked === o.code && <span className="text-red-400 shrink-0">✓</span>}
                </button>
              ))}
            </div>

            <div className="p-6 pt-4 shrink-0 border-t border-neutral-800">
              {error && <p className="text-rose-400 text-sm mb-3">{error}</p>}
              <button
                onClick={save}
                disabled={busy}
                className="w-full py-3 rounded-xl bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 font-semibold shadow-lg shadow-red-950/50 disabled:opacity-50"
              >
                {busy ? "Saving..." : "Save"}
              </button>
            </div>
          </>
        ) : tab === "bank" ? (
          <BankTab currentBalance={currentBalance} onChanged={onBanksChanged} onApplyBalance={onApplyBalance} />
        ) : (
          <form onSubmit={changePassword} className="p-6 pt-3 space-y-3 overflow-y-auto">
            <input
              autoFocus
              type="password"
              required
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
            />
            <input
              type="password"
              required
              minLength={6}
              placeholder="New password (min 6 chars)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
            />
            <input
              type="password"
              required
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
            />
            {pwError && <p className="text-rose-400 text-sm">{pwError}</p>}
            {pwSuccess && <p className="text-red-400 text-sm">Password changed.</p>}
            <button
              disabled={pwBusy}
              className="w-full py-3 rounded-xl bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 font-semibold shadow-lg shadow-red-950/50 disabled:opacity-50"
            >
              {pwBusy ? "Saving..." : "Change password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

type PlaidAccountRow = {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  lastBalance: number | null;
  lastSyncedAt: string | null;
  entryId: string | null;
};

type PlaidItemRow = {
  id: string;
  institutionName: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  accounts: PlaidAccountRow[];
};

// The "Bank" settings tab: connect any number of banks via Plaid Link, see
// what's linked, sync on demand, and unlink. Debt/credit accounts sync fully
// automatically (see lib/plaid-sync.ts); the checking/savings total is
// surfaced here rather than applied silently, since blindly overwriting the
// tracked balance could clash with edits already made for past months.
type SimplefinAccountRow = {
  id: string;
  orgName: string | null;
  name: string;
  currency: string;
  kind: "cash" | "debt" | "ignore";
  lastBalance: number | null;
  entryId: string | null;
};

type SimplefinConnRow = {
  id: string;
  status: string;
  error: string | null;
  lastSyncedAt: string | null;
  accounts: SimplefinAccountRow[];
};

function BankTab({
  currentBalance,
  onChanged,
  onApplyBalance,
}: {
  currentBalance: number;
  onChanged: () => void;
  onApplyBalance: (newBalance: number) => void;
}) {
  const fmt = useContext(CurrencyContext);
  const [items, setItems] = useState<PlaidItemRow[] | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadItems() {
    const r = await fetch("/api/plaid/items");
    if (r.ok) setItems(await r.json());
  }
  const [sfConns, setSfConns] = useState<SimplefinConnRow[] | null>(null);
  const [reimportBusy, setReimportBusy] = useState(false);
  const [reimportNotice, setReimportNotice] = useState<string | null>(null);
  async function loadSimplefin() {
    const r = await fetch("/api/simplefin/connections");
    if (r.ok) setSfConns(await r.json());
  }
  useEffect(() => {
    loadItems();
    loadSimplefin();
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken ?? "",
    onSuccess: async (publicToken, metadata) => {
      setBusy(true);
      setError(null);
      const r = await fetch("/api/plaid/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicToken,
          institutionId: metadata.institution?.institution_id ?? null,
          institutionName: metadata.institution?.name ?? null,
        }),
      });
      setBusy(false);
      setLinkToken(null);
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        return setError(body?.error ?? "Failed to link that bank");
      }
      await loadItems();
      onChanged();
    },
    onExit: () => setLinkToken(null),
  });
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  async function connect() {
    setError(null);
    setBusy(true);
    const r = await fetch("/api/plaid/link-token", { method: "POST" });
    setBusy(false);
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      return setError(body?.error ?? "Failed to start bank connection");
    }
    const { linkToken: token } = await r.json();
    setLinkToken(token);
  }

  async function sync(itemId: string) {
    setSyncingId(itemId);
    setError(null);
    const r = await fetch("/api/plaid/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId }),
    });
    setSyncingId(null);
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      return setError(body?.error ?? "Sync failed");
    }
    await loadItems();
    onChanged();
  }

  async function remove(itemId: string) {
    if (!confirm("Unlink this bank? Debts it created stay, but they'll stop auto-updating.")) return;
    setSyncingId(itemId);
    const r = await fetch(`/api/plaid/items/${itemId}`, { method: "DELETE" });
    setSyncingId(null);
    if (!r.ok) return setError("Failed to unlink");
    await loadItems();
    onChanged();
  }

  async function reimport() {
    if (
      !confirm(
        "Re-import bank transactions?\n\nThis deletes every purchase and income imported from your banks and imports them again, each dated when it happened. Edits you made to imported entries are lost, and imported entries you deleted come back. Your debts aren't affected."
      )
    )
      return;
    setReimportBusy(true);
    setError(null);
    setReimportNotice(null);
    const r = await fetch("/api/bank/reimport", { method: "POST" });
    setReimportBusy(false);
    const body = await r.json().catch(() => null);
    if (!r.ok) return setError(body?.error ?? "Re-import failed");
    const parts = [
      `Removed ${body.removed}`,
      `re-imported ${body.purchases} purchase${body.purchases === 1 ? "" : "s"} and ${body.incomes} deposit${body.incomes === 1 ? "" : "s"}`,
    ];
    if (body.transfers) parts.push(`skipped ${body.transfers} transfer${body.transfers === 1 ? "" : "s"} between your accounts`);
    setReimportNotice(
      parts.join(", ") +
        "." +
        (body.errors?.length ? ` Some banks didn't respond (${body.errors.join("; ")}) — their transactions come back on the next sync.` : "")
    );
    await Promise.all([loadItems(), loadSimplefin()]);
    onChanged();
  }

  const depositoryTotal = useMemo(() => {
    const balances = [
      ...(items ?? []).flatMap((i) => i.accounts).filter((a) => a.type === "depository"),
      ...(sfConns ?? []).flatMap((c) => c.accounts).filter((a) => a.kind === "cash"),
    ].map((a) => a.lastBalance ?? 0);
    if (balances.length === 0) return null;
    return balances.reduce((s, b) => s + b, 0);
  }, [items, sfConns]);

  return (
    <div className="p-6 pt-3 space-y-4 overflow-y-auto">
      <p className="text-neutral-400 text-sm">
        Connect your banks to auto-track credit cards and loans and import spending. Use Plaid or
        SimpleFIN — whichever supports your bank — and connect as many as you like.
      </p>

      {error && <p className="text-rose-400 text-sm">{error}</p>}

      {depositoryTotal !== null && (
        <div className="bg-neutral-800/60 border border-neutral-700/60 rounded-xl p-4 space-y-2">
          <p className="text-sm text-neutral-400">
            Chequing/savings balance from your banks: <span className="text-white font-semibold">{fmt(depositoryTotal)}</span>
          </p>
          {Math.abs(depositoryTotal - currentBalance) > 0.005 && (
            <button
              onClick={() => onApplyBalance(depositoryTotal)}
              className="text-sm px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/50 text-red-300 hover:bg-red-500/25"
            >
              Use as my tracked balance ({fmt(currentBalance)} → {fmt(depositoryTotal)})
            </button>
          )}
        </div>
      )}

      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 pt-1">Plaid</h3>
      <div className="space-y-2">
        {items === null && <p className="text-sm text-neutral-500 italic">Loading…</p>}
        {items?.length === 0 && (
          <p className="text-sm text-neutral-500 italic">No banks connected yet.</p>
        )}
        {items?.map((item) => (
          <div key={item.id} className="bg-neutral-800/60 border border-neutral-700/60 rounded-xl p-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div>
                <p className="font-semibold">{item.institutionName ?? "Connected bank"}</p>
                {item.status === "error" && (
                  <p className="text-xs text-rose-400">{item.error ?? "Needs attention"}</p>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => sync(item.id)}
                  disabled={syncingId === item.id}
                  className="text-xs px-2.5 py-1.5 rounded-lg bg-neutral-700/60 hover:bg-neutral-700 disabled:opacity-50"
                >
                  {syncingId === item.id ? "Syncing…" : "Sync now"}
                </button>
                <button
                  onClick={() => remove(item.id)}
                  disabled={syncingId === item.id}
                  className="text-xs px-2.5 py-1.5 rounded-lg bg-neutral-700/60 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-50"
                >
                  Unlink
                </button>
              </div>
            </div>
            <div className="space-y-1">
              {item.accounts.map((a) => (
                <div key={a.id} className="flex items-center justify-between text-sm text-neutral-400">
                  <span>
                    {a.name}
                    {a.mask ? ` ••${a.mask}` : ""}
                    <span className="text-neutral-600"> · {a.subtype ?? a.type}</span>
                  </span>
                  <span className="tabular-nums">{a.lastBalance != null ? fmt(a.lastBalance) : "—"}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={connect}
        disabled={busy}
        className="w-full py-3 rounded-xl bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 font-semibold shadow-lg shadow-red-950/50 disabled:opacity-50"
      >
        {busy ? "Connecting…" : "Connect a bank with Plaid"}
      </button>

      <SimplefinSection
        conns={sfConns}
        reload={loadSimplefin}
        onChanged={onChanged}
        onError={setError}
      />

      {((items?.length ?? 0) > 0 || (sfConns?.length ?? 0) > 0) && (
        <div className="border-t border-neutral-800 pt-4 space-y-2">
          <p className="text-xs text-neutral-500">
            Spending imports as purchases and deposits (pay, e-transfers) as income, each in the month it
            happened. Transfers between your own accounts are skipped. If you also log your pay by hand,
            remove that entry so it isn't counted twice.
          </p>
          {reimportNotice && <p className="text-sm text-neutral-300">{reimportNotice}</p>}
          <button
            onClick={reimport}
            disabled={reimportBusy}
            className="w-full py-2.5 rounded-xl border border-neutral-700 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            {reimportBusy ? "Re-importing…" : "Fix imported transactions (re-import)"}
          </button>
        </div>
      )}
    </div>
  );
}

// SimpleFIN Bridge: the user connects banks on simplefin.org and pastes a
// one-time setup token here. SimpleFIN has no account types, so each account
// shows its guessed kind with a picker to correct it.
function SimplefinSection({
  conns,
  reload,
  onChanged,
  onError,
}: {
  conns: SimplefinConnRow[] | null;
  reload: () => Promise<void>;
  onChanged: () => void;
  onError: (msg: string | null) => void;
}) {
  const fmt = useContext(CurrencyContext);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    onError(null);
    setNotice(null);
    setBusy(true);
    const r = await fetch("/api/simplefin/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: token.trim() }),
    });
    setBusy(false);
    const body = await r.json().catch(() => null);
    if (!r.ok) return onError(body?.error ?? "Failed to connect SimpleFIN");
    setToken("");
    if (body?.syncError) setNotice(`Connected, but the first sync failed: ${body.syncError}. Try "Sync now" later.`);
    await reload();
    onChanged();
  }

  async function sync(connectionId: string, force = false) {
    setWorkingId(connectionId);
    onError(null);
    setNotice(null);
    const r = await fetch("/api/simplefin/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, force }),
    });
    setWorkingId(null);
    const body = await r.json().catch(() => null);
    if (!r.ok) return onError(body?.error ?? "Sync failed");
    const result = body?.results?.[connectionId];
    if (result?.error) onError(result.error);
    else if (result?.skipped === "cooldown")
      setNotice("Synced a few minutes ago — SimpleFIN only refreshes about once a day, so there's nothing new yet.");
    await reload();
    onChanged();
  }

  async function setKind(connectionId: string, accountId: string, kind: string) {
    setWorkingId(connectionId);
    const r = await fetch(`/api/simplefin/accounts/${accountId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    setWorkingId(null);
    if (!r.ok) return onError("Failed to change account type");
    await sync(connectionId, true);
  }

  async function remove(connectionId: string) {
    if (!confirm("Remove this SimpleFIN connection? Debts it created stay, but stop auto-updating. Also disable this app on the SimpleFIN Bridge site.")) return;
    setWorkingId(connectionId);
    const r = await fetch(`/api/simplefin/connections/${connectionId}`, { method: "DELETE" });
    setWorkingId(null);
    if (!r.ok) return onError("Failed to remove");
    await reload();
    onChanged();
  }

  return (
    <div className="space-y-2 pt-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">SimpleFIN</h3>
      {notice && <p className="text-sm text-neutral-400">{notice}</p>}
      {conns === null && <p className="text-sm text-neutral-500 italic">Loading…</p>}
      {conns?.map((c) => (
        <div key={c.id} className="bg-neutral-800/60 border border-neutral-700/60 rounded-xl p-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="min-w-0">
              <p className="font-semibold">SimpleFIN Bridge</p>
              <p className="text-xs text-neutral-500">
                {c.lastSyncedAt ? `Synced ${new Date(c.lastSyncedAt).toLocaleString()}` : "Not synced yet"}
              </p>
              {c.error && (
                <p className={`text-xs ${c.status === "error" ? "text-rose-400" : "text-amber-400"}`}>{c.error}</p>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => sync(c.id)}
                disabled={workingId === c.id}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-neutral-700/60 hover:bg-neutral-700 disabled:opacity-50"
              >
                {workingId === c.id ? "Syncing…" : "Sync now"}
              </button>
              <button
                onClick={() => remove(c.id)}
                disabled={workingId === c.id}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-neutral-700/60 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            {c.accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2 text-sm text-neutral-400">
                <span className="min-w-0">
                  {a.name}
                  {a.orgName && <span className="text-neutral-600"> · {a.orgName}</span>}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="tabular-nums">{a.lastBalance != null ? fmt(a.lastBalance) : "—"}</span>
                  <select
                    value={a.kind}
                    disabled={workingId === c.id}
                    onChange={(e) => setKind(c.id, a.id, e.target.value)}
                    aria-label={`Account type for ${a.name}`}
                    className="bg-neutral-800 border border-neutral-700 rounded-lg px-1.5 py-1 text-xs text-neutral-200"
                  >
                    <option value="cash">Cash</option>
                    <option value="debt">Debt</option>
                    <option value="ignore">Ignore</option>
                  </select>
                </span>
              </div>
            ))}
            {c.accounts.length === 0 && <p className="text-xs text-neutral-500 italic">No accounts yet.</p>}
          </div>
        </div>
      ))}
      <form onSubmit={connect} className="space-y-2">
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste SimpleFIN setup token"
          autoComplete="off"
          spellCheck={false}
          className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none text-sm"
        />
        <button
          disabled={busy || !token.trim()}
          className="w-full py-3 rounded-xl border border-red-500/50 bg-red-500/10 text-red-300 font-semibold hover:bg-red-500/20 disabled:opacity-50"
        >
          {busy ? "Connecting…" : "Connect with SimpleFIN"}
        </button>
        <p className="text-xs text-neutral-500">
          Get a token at beta-bridge.simplefin.org → your account → New connection. Each token works once.
        </p>
      </form>
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
  const fmt = useContext(CurrencyContext);
  const [pickingDebt, setPickingDebt] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm grid place-items-center z-50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={pickingDebt ? "Which card or loan?" : `Mark "${label}" as paid`}
        className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-bold">
            {pickingDebt ? "Which card or loan?" : `Mark "${label}" as paid`}
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white">✕</button>
        </div>
        <p className="text-neutral-400 text-sm mb-4">
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
                className="w-full text-left px-4 py-3 rounded-xl border border-rose-700/40 bg-rose-700/10 hover:bg-rose-700/20 transition disabled:opacity-50"
              >
                <p className="font-semibold text-rose-400">{d.label}</p>
                <p className="text-xs text-neutral-400 mt-0.5">
                  {fmt(d.amount)} owed → {fmt(d.amount + amount)} after this
                </p>
              </button>
            ))}
            <button
              onClick={() => setPickingDebt(false)}
              className="w-full px-4 py-2.5 rounded-xl border border-neutral-700 text-neutral-400 hover:text-white text-sm"
            >
              Back
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              disabled={busy}
              onClick={() => onChoose("balance")}
              className="w-full text-left px-4 py-3 rounded-xl border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 transition disabled:opacity-50"
            >
              <p className="font-semibold text-red-300">From balance</p>
              <p className="text-xs text-neutral-400 mt-0.5">Deducted from your tracked income — reduces balance.</p>
            </button>
            <button
              disabled={busy}
              onClick={() => onChoose("off")}
              className="w-full text-left px-4 py-3 rounded-xl border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 transition disabled:opacity-50"
            >
              <p className="font-semibold text-white">Off balance</p>
              <p className="text-xs text-neutral-400 mt-0.5">Paid from outside money — balance stays unaffected.</p>
            </button>
            <button
              disabled={busy || debts.length === 0}
              onClick={() => setPickingDebt(true)}
              className="w-full text-left px-4 py-3 rounded-xl border border-rose-700/40 bg-rose-700/10 hover:bg-rose-700/20 transition disabled:opacity-40"
            >
              <p className="font-semibold text-rose-400">Paid with card / debt</p>
              <p className="text-xs text-neutral-400 mt-0.5">
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
  const fmt = useContext(CurrencyContext);
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
        role="dialog"
        aria-modal="true"
        aria-label={`Payments — ${label}`}
        className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-bold">Payments — {label}</h2>
          <button onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white">✕</button>
        </div>
        <p className="text-neutral-400 text-sm mb-4">
          {fmt(remaining)} remaining · started at {fmt(originalAmount)}
        </p>

        <form onSubmit={submit} className="space-y-2 mb-5">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setKind("payment")}
              className={`px-3 py-2.5 rounded-xl border text-sm font-medium transition ${
                kind === "payment"
                  ? "bg-red-500/20 border-red-500 text-red-200"
                  : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white"
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
                  : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white"
              }`}
            >
              Card usage
            </button>
          </div>
          <p className="text-xs text-neutral-500">
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
                    ? "bg-neutral-400/20 border-neutral-400 text-white"
                    : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white"
                }`}
              >
                From balance
              </button>
              <button
                type="button"
                onClick={() => setFromBalance(false)}
                className={`px-3 py-2 rounded-xl border text-xs font-medium transition ${
                  !fromBalance
                    ? "bg-neutral-600/40 border-neutral-500 text-white"
                    : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white"
                }`}
              >
                Off balance
              </button>
              <p className="col-span-2 text-[11px] text-neutral-500">
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
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-rose-700 outline-none"
          />
          <input
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-rose-700 outline-none"
          />
          <button
            disabled={busy}
            className="w-full py-3 rounded-xl bg-gradient-to-b from-rose-700 to-rose-800 hover:to-rose-700 text-neutral-950 font-semibold shadow-lg shadow-rose-950/50 disabled:opacity-50"
          >
            {busy ? "Logging..." : kind === "payment" ? "Log payment" : "Log card usage"}
          </button>
        </form>

        <p className="text-xs uppercase tracking-wider text-neutral-500 mb-2">History</p>
        {history.length === 0 ? (
          <p className="text-sm text-neutral-500 italic">No payments logged yet.</p>
        ) : (
          <div className="space-y-1.5">
            {history.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 bg-neutral-800/60 border border-neutral-700 rounded-lg px-3 py-2"
              >
                <div className="min-w-0">
                  <p className={`font-medium tabular-nums ${p.kind === "charge" ? "text-rose-300" : "text-red-300"}`}>
                    {p.kind === "charge" ? `+${fmt(p.amount)}` : `−${fmt(p.amount)}`}
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-neutral-500">
                      {p.kind === "charge" ? "Usage" : p.fromBalance ? "Payment · from balance" : "Payment · off balance"}
                    </span>
                  </p>
                  <p className="text-xs text-neutral-500 truncate">
                    {new Date(p.paidAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                    {p.note ? ` · ${p.note}` : ""}
                  </p>
                </div>
                <button
                  onClick={() => onUndo(p.id)}
                  className="text-xs text-neutral-500 hover:text-rose-400 shrink-0"
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
          <stop offset="0%" stopColor="#be123c" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#be123c" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#payoffFill)" />
      <polyline points={pts} fill="none" stroke="#be123c" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

