"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  anchorLedger,
  planBudget,
  matchesKeywords,
  shouldBuy,
  nextPayDate,
  type BuyAdvice,
  type BankBalance,
  type BudgetItem,
  type BudgetPlan,
  planSavingsGoal,
  type SavingsGoal,
} from "./lib";
import { IMPORT_NOTE } from "@/lib/constants";
import { CATEGORIES, type Category } from "@/lib/categorize";

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
  initialBank,
  initialBudgetItems,
  userDebtSharePct,
}: {
  initialEntries: Entry[];
  userEmail: string;
  userName: string | null;
  userCurrency: string;
  userBalanceAdjustment: number;
  initialBank: BankBalance | null;
  initialBudgetItems: BudgetItem[];
  userDebtSharePct: number;
}) {
  const [currency, setCurrency] = useState(userCurrency);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Phones show one tab at a time (bottom tab bar); md+ shows everything.
  const [phoneTab, setPhoneTab] = useState<"home" | "money" | "debt">("home");
  const [moneyTab, setMoneyTab] = useState<"all" | "income" | "expense" | "purchase" | "circulation">("all");
  // Full class names on purpose: Tailwind only generates classes it finds
  // written out in the source, so `md:${display}` would never be built.
  const PHONE_HIDDEN = { block: "hidden md:block", grid: "hidden md:grid", flex: "hidden md:flex" } as const;
  const phoneShow = (visible: boolean, display: keyof typeof PHONE_HIDDEN = "block") =>
    visible ? "" : PHONE_HIDDEN[display];
  const goTab = (t: typeof phoneTab) => {
    setPhoneTab(t);
    window.scrollTo({ top: 0 });
  };
  const fmt = useMemo(() => makeFmt(currency), [currency]);

  const [balanceAdjustment, setBalanceAdjustment] = useState(userBalanceAdjustment);
  // Connected chequing/savings total. When present, it *is* the balance.
  const [bank, setBank] = useState<BankBalance | null>(initialBank);
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
  // Share of spare money that goes to extra debt payments. Saved to the
  // account (debounced) and shared by the Budget and the Debt payment plan.
  const [payoutPct, setPayoutPct] = useState(userDebtSharePct);
  const savedPct = useRef(userDebtSharePct);
  useEffect(() => {
    if (payoutPct === savedPct.current) return;
    const t = setTimeout(async () => {
      const r = await fetch("/api/budget", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ debtSharePct: payoutPct }),
      });
      if (r.ok) savedPct.current = payoutPct;
    }, 600);
    return () => clearTimeout(t);
  }, [payoutPct]);
  const [budgetItems, setBudgetItems] = useState<BudgetItem[]>(initialBudgetItems);

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

  // Balance card's refresh button: pull the latest from every connected bank.
  const [syncing, setSyncing] = useState(false);
  async function syncBanks() {
    setSyncing(true);
    await Promise.all([
      fetch("/api/simplefin/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch("/api/plaid/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    ]).catch(() => null);
    await refreshBankAndEntries();
    setSyncing(false);
  }

  // After a bank sync/connect/unlink: entries, the real balance and the
  // transactions feed all change.
  const [feedVersion, setFeedVersion] = useState(0);
  const [buyOpen, setBuyOpen] = useState(false);
  async function refreshBankAndEntries() {
    const [, r] = await Promise.all([refreshEntries(), fetch("/api/bank/balance")]);
    if (r.ok) setBank(await r.json());
    setFeedVersion((v) => v + 1);
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
  // So the Subscriptions card can tell which detected charges already have
  // a matching Bill, and offer "Add as Bill" only for the rest.
  const billLabels = useMemo(() => new Set(expenses.map((e) => e.label.trim().toLowerCase())), [expenses]);
  const purchases = useMemo(() => entries.filter((e) => e.type === "purchase"), [entries]);
  // Money moving in/out that's neither earned nor spent (e-transfers,
  // refunds, card payments). sourceKind holds the direction: "in" | "out".
  const circulation = useMemo(() => entries.filter((e) => e.type === "circulation"), [entries]);
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

    // With banks connected the starting point doesn't matter — the rows are
    // anchored to the real balance below — so start from zero.
    let carry = bank ? 0 : balanceAdjustment;
    const rows = months.map((month) => {
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

      const monthCirculation = circulation.filter((e) => bornIn(e) === month);
      const circulationIn = sumBy(monthCirculation, (e) => e.sourceKind === "in");
      const circulationOut = sumBy(monthCirculation, (e) => e.sourceKind === "out");

      // Balance and Debt are tracked independently — a debt payment changes
      // what you owe (see the Debt card/table) but never touches this
      // month's cash balance, even when it's flagged "from balance".
      const carryIn = carry;
      const closing =
        carryIn + receivedIncome + circulationIn - circulationOut - spentFromBalance - purchaseSpend;
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
        circulationIn,
        circulationOut,
        closing,
        // What's genuinely free once this month's remaining bills are covered.
        available: closing - billsUnpaid,
      };
    });
    return bank ? anchorLedger(rows, currentMonth, bank.balance) : rows;
  }, [income, expenses, purchases, circulation, startMonth, currentMonth, balanceAdjustment, bank]);

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
  const netCirculation = (monthRow?.circulationIn ?? 0) - (monthRow?.circulationOut ?? 0);
  const monthCirculation = useMemo(
    () => circulation.filter((e) => bornIn(e) === selectedMonth),
    [circulation, selectedMonth]
  );
  // DTI reflects income capacity, not whether this month's paycheck has
  // been ticked "received" yet, so it's keyed off expected income.
  const dti = expectedIncome > 0 ? totalDebt / (expectedIncome * 12) : 0;
  // Set once the budget below is computed: when this month's pay leaves an
  // extra debt payment, the plan projects with that; otherwise it falls back
  // to a share of what's free after bills.
  const [budgetExtra, setBudgetExtra] = useState<number | null>(null);
  const monthlyToDebt = budgetExtra ?? Math.max(0, monthlySurplus * (payoutPct / 100));
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
  const [summaryOpen, toggleSummary] = usePersistentToggle("dt.summary.open", false);

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

  // This month's pay split across bills, debt minimums and essentials.
  const budget: BudgetPlan = useMemo(() => {
    const monthPurchases = purchases.filter((e) => bornIn(e) === selectedMonth);
    const paidThisCycle = (d: (typeof debts)[number]) =>
      d.dueDay != null
        ? paidSinceLastDue(d.dueDay, d.debtPayments)
        : d.debtPayments.some((p) => p.kind === "payment" && monthKey(new Date(p.paidAt)) === selectedMonth);
    const target = payoffOrder.find((d) => d.amount > 0.005);
    return planBudget({
      income: monthRow?.receivedIncome ?? 0,
      bills: monthExpenses.map((e) => ({
        id: e.id,
        label: e.label,
        amount: e.amount,
        // One-off bills are settled when logged; monthly ones once marked paid.
        paid: e.frequency !== "monthly" || e.payments.some((p) => p.month === selectedMonth),
      })),
      debts: debts.map((d) => ({
        id: d.id,
        label: d.label,
        balance: d.amount,
        minPayment: d.minPayment ?? null,
        dueDay: d.dueDay ?? null,
        paid: paidThisCycle(d),
      })),
      essentials: budgetItems.map((b) => ({
        id: b.id,
        label: b.label,
        amount: b.amount,
        spent: b.keywords
          ? monthPurchases.filter((p) => matchesKeywords(p.label, b.keywords)).reduce((s, p) => s + p.amount, 0)
          : 0,
      })),
      debtSharePct: payoutPct,
      target: target ? { id: target.id, label: target.label, balance: target.amount } : null,
    });
  }, [purchases, selectedMonth, debts, payoffOrder, monthRow, monthExpenses, budgetItems, payoutPct]);
  useEffect(() => {
    setBudgetExtra(budgetItems.length > 0 && budget.extraToDebt > 0 ? budget.extraToDebt : null);
  }, [budgetItems.length, budget.extraToDebt]);

  // "Should I buy it?" — judged against this month's plan and real cash.
  const adviseOnBuying = (price: number): BuyAdvice => {
    // Money still to go out this month for needs that aren't paid yet.
    const upcomingNeeds = budget.lines.reduce(
      (s, l) => s + (l.paid ? 0 : l.kind === "essential" ? Math.max(0, l.need - (l.spent ?? 0)) : l.need),
      0
    );
    // Typical month: average pay over the last few months that had any.
    const pastIncome = ledger
      .filter((r) => r.month < currentMonth && r.receivedIncome > 0)
      .slice(-3)
      .map((r) => r.receivedIncome);
    const avgIncome = pastIncome.length
      ? pastIncome.reduce((a, b) => a + b, 0) / pastIncome.length
      : monthRow?.receivedIncome ?? 0;
    const monthlyFree = Math.max(0, avgIncome - budget.totalNeed) * (1 - payoutPct / 100);
    // What it costs to spend this instead of putting it on the priority debt.
    const target = payoffOrder.find((d) => d.amount > 0.005);
    let debtCost: { months: number; interest: number } | null = null;
    if (target && plan.monthsToClear !== Infinity) {
      const without = simulatePayoff(
        debts.map((d) => (d.id === target.id ? { ...d, amount: Math.max(0, d.amount - price) } : d)),
        strategy,
        monthlyToDebt
      );
      if (without.monthsToClear !== Infinity)
        debtCost = {
          months: Math.max(0, plan.monthsToClear - without.monthsToClear),
          interest: Math.max(0, plan.totalInterest - without.totalInterest),
        };
    }
    return shouldBuy(
      {
        price,
        freeToSpend: budget.freeToSpend,
        extraToDebt: budget.extraToDebt,
        extraTarget: budget.extraTarget?.label ?? null,
        cash: ledger[ledger.length - 1]?.closing ?? 0,
        upcomingNeeds,
        monthlyFree,
        nextPay: nextPayDate(income.filter((e) => e.frequency !== "monthly").map((e) => new Date(e.createdAt))),
        debtCost,
      },
      fmt
    );
  };

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
    <main className="max-w-7xl mx-auto px-4 sm:px-6 pt-[max(1rem,env(safe-area-inset-top))] md:pt-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-6 space-y-4 md:space-y-6">
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
      <header className="flex items-center justify-between gap-3">
        <div className="hidden md:block">
          <h1 className="text-2xl sm:text-3xl font-bold">
            Hello, <span className="text-red-400">{userName || userEmail.split("@")[0]}</span>
          </h1>
          <p className="text-neutral-400 text-sm">Your money, tracked.</p>
        </div>
        <div className="flex items-center gap-3 flex-1 md:flex-none">
          <div className="flex flex-1 md:flex-none items-center justify-between gap-1 bg-neutral-900/60 border border-neutral-800 rounded-xl px-1 py-1">
            <button
              onClick={() => setSelectedMonth((m) => shiftMonth(m, -1))}
              disabled={selectedMonth <= startMonth}
              className="px-3 md:px-2 py-2 md:py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 disabled:hover:bg-transparent"
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
              className="px-3 md:px-2 py-2 md:py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 disabled:hover:bg-transparent"
              title="Next month"
            >
              ›
            </button>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
            className="hidden md:block p-2.5 rounded-xl border border-neutral-700 hover:bg-neutral-800 transition text-neutral-300 hover:text-white"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="hidden md:inline-flex px-4 py-2 rounded-xl border border-neutral-700 hover:bg-neutral-800 transition text-sm whitespace-nowrap"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Summary cards */}
      <section
        className={`grid grid-cols-2 gap-3 md:gap-4 ${budgetItems.length ? "md:grid-cols-4" : "md:grid-cols-5"} ${phoneShow(phoneTab === "home", "grid")}`}
      >
        <StatCard
          label="Balance"
          value={fmt(balance)}
          accent={balance >= 0 ? "red" : "rose"}
          sub={
            bank
              ? selectedMonth === currentMonth
                ? `In your ${bank.accounts === 1 ? "account" : `${bank.accounts} accounts`}${
                    bank.asOf ? ` · synced ${new Date(bank.asOf).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""
                  }`
                : "End of month, from your bank"
              : monthRow && monthRow.carryIn !== 0
              ? `${fmt(monthRow.carryIn)} carried in`
              : "Left at end of this month"
          }
          // The bank sets the balance when connected — nothing to adjust.
          onEdit={bank ? undefined : () => setAdjustBalanceOpen(true)}
          action={bank ? { label: syncing ? "Syncing banks…" : "Sync banks now", busy: syncing, onClick: syncBanks } : undefined}
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
        {budgetItems.length === 0 && (
        <div className="col-span-2 md:col-span-1">
          {(
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
          )}
        </div>
        )}
      </section>

      {monthRow && monthRow.expectedIncome > monthRow.receivedIncome && (
        <p className={`text-sm text-red-300 bg-red-400/10 border border-red-400/25 rounded-xl px-4 py-2.5 ${phoneShow(phoneTab === "home")}`}>
          {fmt(monthRow.expectedIncome - monthRow.receivedIncome)} income not received yet — mark it
          received in the Income table once it lands.
        </p>
      )}

      <button
        onClick={() => setBuyOpen(true)}
        className={`w-full text-left bg-neutral-900/60 border border-neutral-800 hover:border-red-500/50 rounded-2xl px-4 md:px-5 py-3 flex items-center gap-3 transition ${phoneShow(phoneTab === "home")}`}
      >
        <span className="w-9 h-9 shrink-0 rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 grid place-items-center">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0" />
          </svg>
        </span>
        <span className="flex-1 min-w-0">
          <span className="block font-semibold">Should I buy it?</span>
          <span className="block text-xs text-neutral-500">Enter a price — see if now's the right time</span>
        </span>
        <span className="text-neutral-500 text-lg">›</span>
      </button>

      <BudgetSection
        className={phoneShow(phoneTab === "home")}
        plan={budget}
        items={budgetItems}
        monthName={monthDisplay(selectedMonth)}
        debtSharePct={payoutPct}
        onSaved={setBudgetItems}
      />

      <SavingsGoalsSection className={phoneShow(phoneTab === "home")} freeToSpend={budget.freeToSpend} />

      <RecurringSection
        className={phoneShow(phoneTab === "home")}
        version={feedVersion}
        existingBillLabels={billLabels}
        onAddBill={addEntry}
      />

      {milestone && (
        <section
          className={`rounded-2xl border p-4 flex items-center gap-4 ${phoneShow(phoneTab === "debt", "flex")} ${
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

      {/* Phones: one money list at a time. */}
      {phoneTab === "money" && (
        <div className="md:hidden grid grid-cols-5 gap-1 bg-neutral-900/80 border border-neutral-800 rounded-xl p-1 sticky top-[max(0.5rem,env(safe-area-inset-top))] z-30 backdrop-blur">
          {(
            [
              ["all", "All", null],
              ["income", "Income", totalIncome],
              ["expense", "Bills", totalExpense],
              ["purchase", "Spent", totalPurchases],
              ["circulation", "Moves", netCirculation],
            ] as const
          ).map(([key, label, amount]) => (
            <button
              key={key}
              onClick={() => setMoneyTab(key)}
              className={`rounded-lg px-1 py-1.5 text-center transition ${
                moneyTab === key ? "bg-red-500 text-neutral-950" : "text-neutral-300"
              }`}
            >
              <span className="block text-xs font-semibold">{label}</span>
              <span className={`block text-[11px] tabular-nums truncate ${moneyTab === key ? "text-neutral-900" : "text-neutral-500"}`}>
                {amount == null
                  ? "banks"
                  : // Whole dollars: five tabs leave no room for cents on a phone.
                    new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Category tables */}
      <section className={`grid md:grid-cols-2 xl:grid-cols-3 gap-6 ${phoneShow(phoneTab !== "home", "grid")}`}>
        <CategoryTable
          className={phoneShow(phoneTab === "money" && moneyTab === "income", "flex")}
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
          className={phoneShow(phoneTab === "money" && moneyTab === "expense", "flex")}
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
          className={phoneShow(phoneTab === "money" && moneyTab === "purchase", "flex")}
          title="Purchases"
          color="crimson"
          rows={purchases.filter((e) => monthKey(new Date(e.createdAt)) === selectedMonth)}
          total={totalPurchases}
          onAdd={() => setModalType("purchase")}
          onDelete={deleteEntry}
          onEdit={setEditEntry}
        />
        <CategoryTable
          className={phoneShow(phoneTab === "money" && moneyTab === "circulation", "flex")}
          title="Circulation"
          color="neutral"
          rows={monthCirculation}
          total={netCirculation}
          summary={`In ${fmt(monthRow?.circulationIn ?? 0)} · Out ${fmt(monthRow?.circulationOut ?? 0)}`}
          onDelete={deleteEntry}
          onEdit={setEditEntry}
        />
        <CategoryTable
          className={phoneShow(phoneTab === "debt", "flex")}
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

      <TransactionsFeed
        className={phoneShow(phoneTab === "money" && moneyTab === "all")}
        month={selectedMonth}
        version={feedVersion}
      />

      {/* Summary table */}
      <section className={`bg-neutral-900/60 border border-neutral-800 rounded-2xl overflow-hidden ${phoneShow(phoneTab === "money")}`}>
        <button
          onClick={toggleSummary}
          className={`w-full px-5 py-3 flex items-center justify-between text-left ${summaryOpen ? "border-b border-neutral-800" : ""}`}
        >
          <h2 className="text-lg font-bold flex items-center gap-2">
            <span className={`text-neutral-500 transition-transform ${summaryOpen ? "rotate-90" : ""}`}>›</span>
            Monthly summary
          </h2>
          <span className="text-sm tabular-nums text-neutral-300">Net {fmt(balance)}</span>
        </button>
        {summaryOpen && (
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
              label="Circulation"
              count={monthCirculation.length}
              total={netCirculation}
              color="neutral"
              note="E-transfers, refunds, card payments — not income or spending"
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
                {bank
                  ? "Your connected accounts' balance"
                  : "Income − Bills − Purchases ± Circulation (debt is tracked separately, not netted in)"}
              </td>
            </tr>
          </tbody>
        </table>
        )}
      </section>

      {/* Debt payment plan */}
      <section className={`bg-gradient-to-br from-rose-700/10 via-neutral-900 to-neutral-900 border border-rose-700/30 rounded-2xl p-4 md:p-5 ${phoneShow(phoneTab === "debt")}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2">
              <span>Debt payment plan</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-rose-700/20 text-rose-400 border border-rose-700/40">
                Smart plan
              </span>
            </h2>
            <p className="text-neutral-400 text-sm">
              {budgetExtra != null ? (
                <>
                  Driven by <span className="text-white">your budget</span>: minimums plus {fmt(budgetExtra)} extra a month.
                </>
              ) : (
                <>
                  Driven by what's <span className="text-white">free after this month's bills</span> ({fmt(monthlySurplus)}).
                </>
              )}
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

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
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
              className={`text-sm text-neutral-400 hover:text-white flex items-center gap-1.5 ${showPlanDetails ? "mb-5" : ""}`}
            >
              <span className={`transition-transform ${showPlanDetails ? "rotate-90" : ""}`}>›</span>
              {showPlanDetails ? "Hide" : "Show"} payoff order, chart &amp; tips
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
        ) : showPlanDetails && (
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

        {(showPlanDetails || debts.length === 0) && suggestions.length > 0 && (
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

      <PhoneTabBar tab={phoneTab} onTab={goTab} onSettings={() => setSettingsOpen(true)} />

      {buyOpen && (
        <ShouldBuyModal
          isCurrentMonth={selectedMonth === currentMonth}
          advise={adviseOnBuying}
          onClose={() => setBuyOpen(false)}
        />
      )}

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
          onClose={() => setSettingsOpen(false)}
          onSaved={(code) => {
            setCurrency(code);
            setSettingsOpen(false);
          }}
          onBanksChanged={refreshBankAndEntries}
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

// "RBC Royal Bank · Chequing", or just the account when its name already
// says the bank ("RBC Day to Day Banking").
function sourceName(src: { institution: string | null; account: string }) {
  const bankWord = src.institution?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!bankWord || src.account.toLowerCase().startsWith(bankWord)) return src.account;
  return `${src.institution} · ${src.account}`;
}

function CategoryTable({
  className = "",
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
  summary,
}: {
  className?: string;
  title: string;
  color: "red" | "rose" | "maroon" | "crimson" | "neutral";
  rows: Entry[];
  total: number;
  // Omitted for sections filled only by bank sync (Circulation).
  onAdd?: () => void;
  // Extra line under the total, e.g. Circulation's in/out split.
  summary?: string;
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
  // Bank sync can put dozens of rows in a month; show the latest few.
  const ROW_LIMIT = 5;
  const [showAll, setShowAll] = useState(false);
  // Bank picker: with more than one bank's transactions in the list, pick
  // one to see only its rows (entries added by hand count as "Manual").
  const bankOf = (e: Entry) => (e.source ? e.source.institution || e.source.account : "Manual");
  const banks = useMemo(() => Array.from(new Set(rows.filter((e) => e.source).map(bankOf))).sort(), [rows]);
  const hasManual = rows.some((e) => !e.source);
  const [bank, setBank] = useState<string | null>(null);
  const activeBank = bank && (banks.includes(bank) || (bank === "Manual" && hasManual)) ? bank : null;
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const byBank = activeBank ? rows.filter((e) => bankOf(e) === activeBank) : rows;
  const filtered = q ? byBank.filter((e) => e.label.toLowerCase().includes(q) || bankOf(e).toLowerCase().includes(q)) : byBank;
  const shown = showAll ? filtered : filtered.slice(0, ROW_LIMIT);
  const showPicker = banks.length > 1 || (banks.length === 1 && hasManual);
  const showSearch = rows.length > ROW_LIMIT;
  const map = {
    red: { bar: "bg-red-500", text: "text-red-400", chip: "bg-red-500/15 border-red-500/30", btn: "bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 shadow-md shadow-red-950/40" },
    rose: { bar: "bg-rose-500", text: "text-rose-400", chip: "bg-rose-500/15 border-rose-500/30", btn: "bg-gradient-to-b from-rose-500 to-rose-600 hover:to-rose-500 text-white shadow-md shadow-rose-950/40" },
    maroon: { bar: "bg-rose-700", text: "text-rose-600", chip: "bg-rose-700/15 border-rose-700/30", btn: "bg-gradient-to-b from-rose-700 to-rose-800 hover:to-rose-700 text-neutral-950 shadow-md shadow-rose-950/40" },
    crimson: { bar: "bg-red-600", text: "text-red-500", chip: "bg-red-600/15 border-red-600/30", btn: "bg-gradient-to-b from-red-600 to-red-700 hover:to-red-600 text-white shadow-md shadow-red-950/40" },
    neutral: { bar: "bg-neutral-500", text: "text-neutral-300", chip: "bg-neutral-500/15 border-neutral-500/30", btn: "bg-neutral-700 hover:bg-neutral-600 text-white" },
  }[color];
  return (
    <div className={`bg-neutral-900/60 border border-neutral-800 rounded-2xl overflow-hidden flex flex-col ${className}`}>
      <div className={`h-1 ${map.bar}`} />
      <div className="px-5 py-3 flex items-center justify-between border-b border-neutral-800">
        <div>
          <h3 className="text-lg font-bold">{title}</h3>
          <p className={`text-sm tabular-nums ${map.text} font-semibold`}>{fmt(total)}</p>
          {summary && <p className="text-xs text-neutral-500 tabular-nums">{summary}</p>}
          {activeBank && (
            <p className="text-xs text-neutral-400 tabular-nums">
              {activeBank}: {fmt(filtered.reduce((s, e) => s + (e.type === "circulation" && e.sourceKind === "out" ? -e.amount : e.amount), 0))}
            </p>
          )}
        </div>
        {onAdd ? (
          <button onClick={onAdd} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${map.btn}`}>
            + Add
          </button>
        ) : (
          <span className="text-xs text-neutral-500">From your bank</span>
        )}
      </div>
      {showSearch && (
        <div className="px-3 sm:px-4 pt-2">
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setShowAll(false);
            }}
            placeholder="Search…"
            className="w-full px-3 py-1.5 rounded-lg bg-neutral-800/60 border border-neutral-700 text-sm placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500"
          />
        </div>
      )}
      {showPicker && (
        <div className="px-3 sm:px-4 py-2 flex gap-1.5 overflow-x-auto border-b border-neutral-800">
          {[null, ...banks, ...(hasManual ? ["Manual"] : [])].map((b) => (
            <button
              key={b ?? "all"}
              onClick={() => {
                setBank(b);
                setShowAll(false);
              }}
              className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                activeBank === b ? `${map.chip} text-white` : "border-neutral-700 text-neutral-400 hover:text-white"
              }`}
            >
              {b ?? "All banks"}
            </button>
          ))}
        </div>
      )}
      <div className="overflow-x-auto flex-1">
        <table className="w-full text-sm">
          <thead className="text-neutral-500 text-xs uppercase">
            <tr>
              <th className="text-left px-2.5 sm:px-4 py-2">Label</th>
              <th className="text-right px-2.5 sm:px-4 py-2">Amount</th>
              {showShare && <th className="text-right px-2.5 sm:px-4 py-2 hidden sm:table-cell">Share</th>}
              {onTogglePaid && <th className="text-center px-2.5 sm:px-4 py-2">{marks.header}</th>}
              <th className="px-2.5 sm:px-4 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.length === 0 && (
              <tr>
                <td colSpan={(showShare ? 4 : 3) + (onTogglePaid ? 1 : 0)} className="text-center py-8 text-neutral-500 italic">
                  {onAdd ? "Empty — click + Add" : "Nothing this month"}
                </td>
              </tr>
            )}
            {rows.length > 0 && filtered.length === 0 && (
              <tr>
                <td colSpan={(showShare ? 4 : 3) + (onTogglePaid ? 1 : 0)} className="text-center py-8 text-neutral-500 italic">
                  No matches
                </td>
              </tr>
            )}
            {shown.map((e) => {
              const paid = !!selectedMonth && e.payments.some((p) => p.month === selectedMonth);
              return (
              <tr key={e.id} className={`hover:bg-neutral-800/40 ${paid ? "bg-red-500/5" : ""}`}>
                <td className="px-2.5 sm:px-4 py-2">
                  <p className="font-medium flex flex-wrap items-center gap-x-2 gap-y-0.5 break-words">
                    {e.label}
                    {e.type === "circulation" ? (
                      <>
                        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                          {new Date(e.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-neutral-700/50 text-neutral-400 border border-neutral-600/40">
                          {e.sourceKind === "out" ? "Out" : "In"}
                        </span>
                      </>
                    ) : e.type === "purchase" ? (
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
                  {e.source && (
                    <p className="text-[11px] text-neutral-500 truncate max-w-[40vw] sm:max-w-xs">
                      {sourceName(e.source)}
                    </p>
                  )}
                  {e.note && e.note !== IMPORT_NOTE && (
                    <p className="text-xs text-neutral-500 break-words">{e.note}</p>
                  )}
                  {onLogPayment && (!!e.paidSoFar || !!e.chargedSoFar) && (
                    <p className="text-xs text-neutral-500 break-words">
                      {fmt(e.paidSoFar ?? 0)} paid
                      {e.chargedSoFar ? ` · ${fmt(e.chargedSoFar)} used` : ""} · started {fmt(e.originalAmount ?? e.amount)}
                    </p>
                  )}
                </td>
                <td className={`px-2.5 sm:px-4 py-2 text-right tabular-nums font-semibold ${map.text}`}>
                  {e.type === "circulation" ? `${e.sourceKind === "out" ? "−" : "+"}${fmt(e.amount)}` : fmt(e.amount)}
                </td>
                {showShare && (
                  <td className="px-2.5 sm:px-4 py-2 text-right text-neutral-400 tabular-nums hidden sm:table-cell">
                    {total ? pct(e.amount / total) : "—"}
                  </td>
                )}
                {onTogglePaid && (
                  <td className="px-2.5 sm:px-4 py-2 text-center">
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
                <td className="px-2.5 sm:px-4 py-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {onLogPayment && (
                      <button
                        onClick={() => onLogPayment(e.id, e.label)}
                        className="px-2 py-1 rounded-lg text-xs font-semibold whitespace-nowrap bg-rose-700/15 border border-rose-700/30 text-rose-400 hover:bg-rose-700/25"
                      >
                        + Pay
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
      {filtered.length > ROW_LIMIT && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full py-2 text-xs text-neutral-400 hover:text-white border-t border-neutral-800"
        >
          {showAll ? "Show fewer" : `Show all ${filtered.length}`}
        </button>
      )}
    </div>
  );
}

function ShouldBuyModal({
  isCurrentMonth,
  advise,
  onClose,
}: {
  isCurrentMonth: boolean;
  advise: (price: number) => BuyAdvice;
  onClose: () => void;
}) {
  useEscapeClose(onClose);
  const [what, setWhat] = useState("");
  const [price, setPrice] = useState("");
  const [advice, setAdvice] = useState<BuyAdvice | null>(null);
  const [asked, setAsked] = useState<{ what: string; price: number } | null>(null);
  const fmt = useContext(CurrencyContext);

  function check(e: React.FormEvent) {
    e.preventDefault();
    const p = parseFloat(price.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(p) || p <= 0) return;
    setAdvice(advise(p));
    setAsked({ what: what.trim(), price: p });
  }

  const tone = {
    yes: { box: "bg-neutral-500/10 border-neutral-400/40", badge: "bg-neutral-200 text-neutral-950", label: "Go for it" },
    wait: { box: "bg-red-400/10 border-red-400/40", badge: "bg-red-400 text-neutral-950", label: "Wait" },
    no: { box: "bg-rose-500/10 border-rose-500/40", badge: "bg-rose-500 text-white", label: "Don't buy now" },
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 sm:p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Should I buy it?"
        className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-6 px-6 pt-6 w-full max-w-md shadow-2xl max-h-[90dvh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-bold">Should I buy it?</h2>
          <button onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white text-lg leading-none p-2 -m-1">
            ✕
          </button>
        </div>
        <p className="text-sm text-neutral-400 mb-4">
          Checks the price against this month's pay, bills, debt payments and what's in your bank.
        </p>
        {!isCurrentMonth && (
          <p className="text-xs text-red-300 mb-3">Based on this month's numbers, not the month you're viewing.</p>
        )}
        <form onSubmit={check} className="space-y-3">
          <input
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            placeholder="What is it? (optional)"
            className="w-full px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none"
          />
          <div className="flex gap-2">
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Price"
              inputMode="decimal"
              required
              className="flex-1 min-w-0 px-4 py-3 rounded-xl bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none tabular-nums"
            />
            <button className="px-5 py-3 rounded-xl bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 font-semibold">
              Check
            </button>
          </div>
        </form>

        {advice && asked && (
          <div className={`mt-4 rounded-xl border p-4 space-y-2 ${tone[advice.verdict].box}`} aria-live="polite">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${tone[advice.verdict].badge}`}>
                {tone[advice.verdict].label}
              </span>
              <span className="text-sm text-neutral-400">
                {asked.what ? `${asked.what} · ` : ""}
                {fmt(asked.price)}
              </span>
            </div>
            <p className="font-semibold text-white">{advice.headline}</p>
            <ul className="space-y-1.5 text-sm text-neutral-300 list-disc pl-5">
              {advice.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

type FeedRow = {
  id: string;
  institution: string | null;
  account: string;
  date: string;
  amount: number;
  description: string;
  kind: "income" | "purchase" | "circulation" | "transfer";
  category: Category | null;
};

const KIND_LABEL: Record<FeedRow["kind"], string> = {
  income: "Income",
  purchase: "Spent",
  circulation: "Moves",
  transfer: "Transfer",
};

type RecurringCharge = {
  label: string;
  amount: number;
  occurrences: number;
  lastDate: string;
  avgIntervalDays: number;
  monthlyAmount: number;
};

// Subscriptions and other bills that repeat on their own (Netflix, gym...),
// spotted from a year of imported purchases — see lib/recurring.ts. Nothing
// to set up: it just watches for the pattern.
function RecurringSection({
  version,
  className = "",
  existingBillLabels,
  onAddBill,
}: {
  version: number;
  className?: string;
  // Lower-cased, trimmed labels of Bills that already exist, so a charge
  // already tracked there doesn't also offer "Add as Bill".
  existingBillLabels: Set<string>;
  onAddBill: (payload: { type: "expense"; label: string; amount: number; frequency: "monthly"; note?: string }) => Promise<void>;
}) {
  const fmt = useContext(CurrencyContext);
  const [charges, setCharges] = useState<RecurringCharge[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  async function addAsBill(c: RecurringCharge) {
    setAdding(c.label);
    try {
      await onAddBill({
        type: "expense",
        label: c.label,
        amount: Math.round(c.monthlyAmount * 100) / 100,
        frequency: "monthly",
        note: "Added from a detected subscription",
      });
    } finally {
      setAdding(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/bank/recurring")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => !cancelled && setCharges(data))
      .catch(() => !cancelled && setCharges([]));
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (!charges || charges.length === 0) return null;
  const total = charges.reduce((s, c) => s + c.monthlyAmount, 0);
  const LIMIT = 5;
  const visible = showAll ? charges : charges.slice(0, LIMIT);
  const cadence = (days: number) => (days <= 35 ? "Monthly" : days <= 100 ? "Quarterly" : `Every ~${Math.round(days / 30)} months`);

  return (
    <section className={`bg-neutral-900/60 border border-neutral-800 rounded-2xl overflow-hidden ${className}`}>
      <div className="px-4 md:px-5 py-3 border-b border-neutral-800">
        <h2 className="text-lg font-bold">Subscriptions</h2>
        <p className="text-sm tabular-nums text-neutral-400">{fmt(total)}/mo detected</p>
      </div>
      <ul className="divide-y divide-neutral-800/70">
        {visible.map((c) => {
          const alreadyBill = existingBillLabels.has(c.label.trim().toLowerCase());
          return (
          <li key={c.label} className="px-4 md:px-5 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{c.label}</p>
              <p className="text-xs text-neutral-500">
                {cadence(c.avgIntervalDays)} · seen {c.occurrences}× · last{" "}
                {new Date(c.lastDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </p>
              {alreadyBill ? (
                <span className="text-[11px] uppercase tracking-wider text-neutral-500">✓ Tracked as a Bill</span>
              ) : (
                <button
                  onClick={() => addAsBill(c)}
                  disabled={adding === c.label}
                  className="text-[11px] uppercase tracking-wider text-red-400 hover:text-red-300 disabled:opacity-50 font-semibold"
                >
                  {adding === c.label ? "Adding…" : "+ Add as Bill"}
                </button>
              )}
            </div>
            <span className="shrink-0 tabular-nums text-sm font-semibold text-red-400">{fmt(c.amount)}</span>
          </li>
          );
        })}
      </ul>
      {charges.length > LIMIT && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full py-2 text-xs text-neutral-400 hover:text-white border-t border-neutral-800"
        >
          {showAll ? "Show fewer" : `Show all ${charges.length}`}
        </button>
      )}
    </section>
  );
}

// Every transaction from every connected bank, merged into one list like a
// banking app's, tagged with the bank/account it came from and its section.
function TransactionsFeed({ month, version, className = "" }: { month: string; version: number; className?: string }) {
  const fmt = useContext(CurrencyContext);
  const [rows, setRows] = useState<FeedRow[] | null>(null);
  const [bank, setBank] = useState<string>("all");
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    fetch(`/api/bank/transactions?month=${month}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => !cancelled && setRows(data))
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [month, version]);

  const bankOf = (r: FeedRow) => r.institution || r.account;
  const banks = useMemo(() => [...new Set((rows ?? []).map(bankOf))], [rows]);
  const q = search.trim().toLowerCase();
  const shown = (rows ?? []).filter(
    (r) =>
      (bank === "all" || bankOf(r) === bank) &&
      (!q || r.description.toLowerCase().includes(q) || bankOf(r).toLowerCase().includes(q))
  );

  async function setCategory(id: string, category: Category) {
    setRows((cur) => cur && cur.map((r) => (r.id === id ? { ...r, category } : r)));
    const r = await fetch(`/api/bank/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category }),
    });
    if (!r.ok) fetch(`/api/bank/transactions?month=${month}`).then((r) => (r.ok ? r.json() : null)).then((d) => d && setRows(d));
  }
  const LIMIT = 15;
  const visible = showAll ? shown : shown.slice(0, LIMIT);
  const totals = useMemo(() => {
    const t = new Map<string, { in: number; out: number }>();
    for (const r of rows ?? []) {
      if (r.kind === "transfer") continue; // moves between your own accounts net out
      const k = bankOf(r);
      const cur = t.get(k) ?? { in: 0, out: 0 };
      if (r.amount > 0) cur.in += r.amount;
      else cur.out -= r.amount;
      t.set(k, cur);
    }
    return t;
  }, [rows]);

  const dayLabel = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  let lastDay = "";

  return (
    <section className={`bg-neutral-900/60 border border-neutral-800 rounded-2xl overflow-hidden ${className}`}>
      <div className="px-4 md:px-5 py-3 border-b border-neutral-800 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold">All transactions</h2>
          <span className="text-xs text-neutral-500">{rows ? `${shown.length} this month` : ""}</span>
        </div>
        {rows && rows.length > 5 && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search transactions…"
            className="w-full px-3 py-1.5 rounded-lg bg-neutral-800/60 border border-neutral-700 text-sm placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500"
          />
        )}
        {banks.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5">
            {["all", ...banks].map((b) => (
              <button
                key={b}
                onClick={() => setBank(b)}
                className={`shrink-0 px-3 py-1 rounded-full text-xs border ${
                  bank === b ? "bg-red-500 text-neutral-950 border-red-500 font-semibold" : "border-neutral-700 text-neutral-300"
                }`}
              >
                {b === "all" ? "All banks" : b}
              </button>
            ))}
          </div>
        )}
        {totals.size > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-neutral-500 tabular-nums">
            {[...totals].filter(([k]) => bank === "all" || k === bank).map(([k, t]) => (
              <span key={k}>
                <span className="text-neutral-300">{k}</span> +{fmt(t.in)} in · −{fmt(t.out)} out
              </span>
            ))}
          </div>
        )}
      </div>
      {rows === null ? (
        <p className="px-5 py-6 text-sm text-neutral-500 italic">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="px-5 py-6 text-sm text-neutral-500">
          No bank transactions this month. Connect a bank in Settings → Bank — or, if you already have, use "Fix imported
          transactions" there once to fill this list in.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-800/70">
          {visible.map((r) => {
            const day = dayLabel(r.date);
            const header = day !== lastDay;
            lastDay = day;
            return (
              <li key={r.id}>
                {header && (
                  <p className="px-4 md:px-5 pt-3 pb-1 text-[11px] uppercase tracking-wider text-neutral-500 bg-neutral-900/80">{day}</p>
                )}
                <div className="px-4 md:px-5 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">{r.description}</p>
                    <p className="text-xs text-neutral-500 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span>
                        {r.institution ? `${r.institution} · ` : ""}
                        {r.account}
                      </span>
                      <span className={r.kind === "income" ? "text-neutral-200" : r.kind === "purchase" ? "text-red-400" : ""}>
                        {KIND_LABEL[r.kind]}
                      </span>
                      {r.kind === "purchase" && (
                        <select
                          value={r.category ?? "Other"}
                          onChange={(e) => setCategory(r.id, e.target.value as Category)}
                          className="bg-neutral-800/70 border border-neutral-700 rounded px-1 py-0.5 text-[11px] text-neutral-300"
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      )}
                    </p>
                  </div>
                  <span className={`shrink-0 tabular-nums text-sm font-semibold ${r.amount > 0 ? "text-neutral-100" : "text-red-400"}`}>
                    {r.amount > 0 ? "+" : "−"}
                    {fmt(Math.abs(r.amount))}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {shown.length > LIMIT && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full py-2 text-xs text-neutral-400 hover:text-white border-t border-neutral-800"
        >
          {showAll ? "Show fewer" : `Show all ${shown.length}`}
        </button>
      )}
    </section>
  );
}

// Phone navigation, like a native banking app: one focused screen per tab
// instead of one long page. Hidden from md up, where everything fits.
function PhoneTabBar({
  tab,
  onTab,
  onSettings,
}: {
  tab: "home" | "money" | "debt";
  onTab: (t: "home" | "money" | "debt") => void;
  onSettings: () => void;
}) {
  const icon = (d: string) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
  const items = [
    { key: "home" as const, label: "Home", d: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
    { key: "money" as const, label: "Money", d: "M4 7h16M4 12h16M4 17h10" },
    { key: "debt" as const, label: "Debt", d: "M3 6h18v12H3zM3 10h18M7 15h4" },
  ];
  return (
    <nav
      aria-label="Sections"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-neutral-950/95 backdrop-blur border-t border-neutral-800 pb-[env(safe-area-inset-bottom)]"
    >
      <div className="grid grid-cols-4">
        {items.map((it) => (
          <button
            key={it.key}
            onClick={() => onTab(it.key)}
            aria-current={tab === it.key ? "page" : undefined}
            className={`flex flex-col items-center gap-0.5 pt-2 pb-2.5 text-[11px] font-medium ${
              tab === it.key ? "text-red-400" : "text-neutral-500"
            }`}
          >
            {icon(it.d)}
            {it.label}
          </button>
        ))}
        <button onClick={onSettings} className="flex flex-col items-center gap-0.5 pt-2 pb-2.5 text-[11px] font-medium text-neutral-500">
          {icon("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.8-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3.3 14H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20.7 10H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z")}
          Settings
        </button>
      </div>
    </nav>
  );
}

// Remembers whether a section is open on this device (a display preference,
// so localStorage is fine; it's optional and falls back to the default).
function usePersistentToggle(key: string, initial: boolean) {
  const [open, setOpen] = useState(initial);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) setOpen(v === "1");
    } catch {}
  }, [key]);
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "0" : "1");
      } catch {}
      return !o;
    });
  return [open, toggle] as const;
}

// Next calendar date a "due on the Nth" payment falls on.
const nextDueLabel = (dueDay: number) => {
  const d = new Date();
  d.setDate(d.getDate() + daysUntilDue(dueDay));
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

function BudgetSection({
  className = "",
  plan,
  items,
  monthName,
  debtSharePct,
  onSaved,
}: {
  className?: string;
  plan: BudgetPlan;
  items: BudgetItem[];
  monthName: string;
  debtSharePct: number;
  onSaved: (items: BudgetItem[]) => void;
}) {
  const fmt = useContext(CurrencyContext);
  const [open, toggle] = usePersistentToggle("dt.budget.open", true);
  const [editing, setEditing] = useState(false);

  const pay = plan.lines.filter((l) => l.kind !== "essential");
  const essentials = plan.lines.filter((l) => l.kind === "essential");
  const pctCovered = plan.totalNeed > 0 ? Math.min(1, plan.covered / plan.totalNeed) : plan.income > 0 ? 1 : 0;

  const status = (l: (typeof plan.lines)[number]) => {
    if (l.kind === "debt" && l.noMinimum) return { text: "No minimum set", tone: "muted" };
    if (l.paid) return { text: "Paid ✓", tone: "good" };
    if (l.short > 0) return { text: `Short ${fmt(l.short)}`, tone: "bad" };
    if (l.kind === "debt") return { text: l.dueDay ? `Pay by ${nextDueLabel(l.dueDay)}` : "Pay this month", tone: "todo" };
    if (l.kind === "bill") return { text: "Set aside", tone: "todo" };
    if ((l.spent ?? 0) > l.need) return { text: `Over ${fmt((l.spent ?? 0) - l.need)}`, tone: "bad" };
    return { text: "Covered", tone: "good" };
  };
  const chip = {
    good: "bg-neutral-500/15 text-neutral-200 border-neutral-500/30",
    todo: "bg-red-500/15 text-red-300 border-red-500/30",
    bad: "bg-rose-500/20 text-rose-300 border-rose-500/40",
    muted: "bg-neutral-800 text-neutral-500 border-neutral-700",
  } as Record<string, string>;

  const Row = ({ l }: { l: (typeof plan.lines)[number] }) => {
    const st = status(l);
    const left = Math.max(0, l.funded - (l.spent ?? 0));
    const sub =
      l.kind === "essential"
        ? l.spent
          ? l.spent > l.need
            ? `${fmt(l.spent)} spent · over by ${fmt(l.spent - l.need)}`
            : `${fmt(l.spent)} spent · ${fmt(left)} left`
          : `Up to ${fmt(l.funded)} to spend`
        : l.kind === "debt"
        ? "Minimum payment"
        : "Bill";
    return (
      <li className="flex items-center justify-between gap-3 py-2">
        <div className="min-w-0">
          <p className="font-medium break-words">{l.label}</p>
          <p className="text-xs text-neutral-500">{sub}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="tabular-nums text-sm">{l.kind === "debt" && l.noMinimum ? "—" : fmt(l.need)}</span>
          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border whitespace-nowrap ${chip[st.tone]}`}>
            {st.text}
          </span>
        </div>
      </li>
    );
  };

  return (
    <section className={`bg-neutral-900/60 border border-neutral-800 rounded-2xl ${className}`}>
      <button onClick={toggle} className="w-full px-4 md:px-5 py-3 md:py-4 flex items-center justify-between gap-3 text-left">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <span className={`text-neutral-500 transition-transform ${open ? "rotate-90" : ""}`}>›</span>
            Budget
          </h2>
          <p className="text-xs text-neutral-500">{monthName}</p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wider text-neutral-500">Free to spend</p>
          <p className="text-lg font-bold tabular-nums">{fmt(plan.freeToSpend)}</p>
        </div>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          <div>
            <p className="text-sm text-neutral-300">
              {plan.income > 0 ? (
                <>
                  Pay this month <span className="font-semibold text-white tabular-nums">{fmt(plan.income)}</span> ·
                  needs <span className="tabular-nums">{fmt(plan.totalNeed)}</span>
                </>
              ) : (
                <>
                  No pay yet this month. Needs <span className="tabular-nums">{fmt(plan.totalNeed)}</span> — this fills
                  in as your pay arrives.
                </>
              )}
            </p>
            <div className="mt-2 h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden">
              <div className="h-full bg-red-500 rounded-full transition-all" style={{ width: `${pctCovered * 100}%` }} />
            </div>
          </div>

          {editing ? (
            <BudgetEditor
              items={items}
              onCancel={() => setEditing(false)}
              onSaved={(next) => {
                onSaved(next);
                setEditing(false);
              }}
            />
          ) : (
            <div className="grid md:grid-cols-2 gap-x-8 gap-y-2">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Pay first</h3>
                {pay.length === 0 ? (
                  <p className="text-sm text-neutral-500 italic py-2">No bills or debt minimums this month.</p>
                ) : (
                  <ul className="divide-y divide-neutral-800">
                    {pay.map((l) => (
                      <Row key={`${l.kind}-${l.id}`} l={l} />
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Essentials</h3>
                  <button onClick={() => setEditing(true)} className="text-xs text-neutral-400 hover:text-white">
                    {items.length ? "Edit" : "+ Add essentials"}
                  </button>
                </div>
                {essentials.length === 0 ? (
                  <p className="text-sm text-neutral-500 py-2">
                    Add what you need each month — groceries, gas, phone — and your pay gets split across them.
                  </p>
                ) : (
                  <ul className="divide-y divide-neutral-800">
                    {essentials.map((l) => (
                      <Row key={`${l.kind}-${l.id}`} l={l} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {!editing && plan.income > 0 && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/80 p-3 text-sm space-y-1">
              {plan.leftover > 0 ? (
                <>
                  {plan.extraToDebt > 0 && plan.extraTarget && (
                    <p>
                      Put <span className="font-semibold text-red-300 tabular-nums">{fmt(plan.extraToDebt)}</span> extra on{" "}
                      <span className="font-semibold">{plan.extraTarget.label}</span>
                      <span className="text-neutral-500"> ({debtSharePct}% of what's left — set in Debt payment plan)</span>
                    </p>
                  )}
                  <p>
                    Free to spend: <span className="font-semibold text-white tabular-nums">{fmt(plan.freeToSpend)}</span>
                  </p>
                </>
              ) : plan.covered < plan.totalNeed ? (
                <p className="text-rose-300">
                  {fmt(plan.totalNeed - plan.covered)} still needed — cover the items marked Short when your next pay lands.
                </p>
              ) : (
                <p className="text-neutral-400">Everything's covered, with nothing extra left this month.</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function BudgetEditor({
  items,
  onCancel,
  onSaved,
}: {
  items: BudgetItem[];
  onCancel: () => void;
  onSaved: (items: BudgetItem[]) => void;
}) {
  const [rows, setRows] = useState(
    items.length
      ? items.map((i) => ({ label: i.label, amount: String(i.amount), keywords: i.keywords ?? "" }))
      : [{ label: "", amount: "", keywords: "" }]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, k: "label" | "amount" | "keywords", v: string) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, [k]: v } : row)));

  async function save() {
    setError(null);
    const clean = rows
      .filter((r) => r.label.trim() || r.amount.trim())
      .map((r) => ({ label: r.label.trim(), amount: parseFloat(r.amount), keywords: r.keywords.trim() || null }));
    if (clean.some((r) => !r.label || !Number.isFinite(r.amount) || r.amount < 0))
      return setError("Each essential needs a name and an amount.");
    setBusy(true);
    const res = await fetch("/api/budget", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: clean }),
    });
    setBusy(false);
    const body = await res.json().catch(() => null);
    if (!res.ok) return setError(body?.error ?? "Failed to save");
    onSaved(body.items);
  }

  const input = "px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none text-sm";
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Monthly amounts for things you need — not fixed bills (those go in Bills). Add store names to track spending
        against each one.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_6.5rem_auto] gap-2 items-start">
          <input className={input} placeholder="Groceries" value={r.label} onChange={(e) => set(i, "label", e.target.value)} />
          <input
            className={`${input} tabular-nums`}
            placeholder="400"
            inputMode="decimal"
            value={r.amount}
            onChange={(e) => set(i, "amount", e.target.value)}
          />
          <button
            onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
            aria-label={`Remove ${r.label || "essential"}`}
            className="text-neutral-500 hover:text-rose-300 px-2 py-2"
          >
            ✕
          </button>
          <input
            className={`${input} col-span-2 text-xs`}
            placeholder="Store names (optional): costco, superstore"
            value={r.keywords}
            onChange={(e) => set(i, "keywords", e.target.value)}
          />
        </div>
      ))}
      <button
        onClick={() => setRows((rs) => [...rs, { label: "", amount: "", keywords: "" }])}
        className="text-sm text-neutral-400 hover:text-white"
      >
        + Add another
      </button>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="flex-1 py-2.5 rounded-xl bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 font-semibold disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save essentials"}
        </button>
        <button onClick={onCancel} className="px-4 py-2.5 rounded-xl border border-neutral-700 text-sm hover:bg-neutral-800">
          Cancel
        </button>
      </div>
    </div>
  );
}

// Fetches and owns its own goals (like Subscriptions/RecurringSection),
// rather than threading them through Dashboard's already-long prop list —
// the only thing it needs from outside is this month's free-to-spend, so
// its advice always agrees with the Budget section and "Should I buy it?".
function SavingsGoalsSection({ className = "", freeToSpend }: { className?: string; freeToSpend: number }) {
  const fmt = useContext(CurrencyContext);
  const [open, toggle] = usePersistentToggle("dt.goals.open", true);
  const [goals, setGoals] = useState<SavingsGoal[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/goals")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => !cancelled && setGoals(data))
      .catch(() => !cancelled && setGoals([]));
    return () => {
      cancelled = true;
    };
  }, []);

  async function createGoal(input: { name: string; targetAmount: number; targetDate: string | null }) {
    setError(null);
    const r = await fetch("/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      setError(body?.error ?? "Failed to add goal");
      return false;
    }
    setGoals((cur) => [...(cur ?? []), body]);
    setAdding(false);
    return true;
  }

  async function patchGoal(id: string, patch: Record<string, unknown>) {
    setError(null);
    const r = await fetch(`/api/goals/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      setError(body?.error ?? "Failed to save goal");
      return false;
    }
    setGoals((cur) => (cur ?? []).map((g) => (g.id === id ? body : g)));
    return true;
  }

  async function deleteGoal(id: string) {
    if (!confirm("Delete this savings goal?")) return;
    const prev = goals;
    setGoals((cur) => (cur ?? []).filter((g) => g.id !== id));
    const r = await fetch(`/api/goals/${id}`, { method: "DELETE" });
    if (!r.ok) setGoals(prev ?? null);
  }

  const plans = (goals ?? []).map((g) => planSavingsGoal(g, freeToSpend));
  const totalRemaining = plans.reduce((s, p) => s + p.remaining, 0);

  return (
    <section className={`bg-neutral-900/60 border border-neutral-800 rounded-2xl ${className}`}>
      <button onClick={toggle} className="w-full px-4 md:px-5 py-3 md:py-4 flex items-center justify-between gap-3 text-left">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <span className={`text-neutral-500 transition-transform ${open ? "rotate-90" : ""}`}>›</span>
            Savings goals
          </h2>
          <p className="text-xs text-neutral-500">
            {plans.length === 0 ? "Nothing set up yet" : `${plans.filter((p) => !p.done).length} in progress`}
          </p>
        </div>
        {totalRemaining > 0 && (
          <div className="text-right">
            <p className="text-xs uppercase tracking-wider text-neutral-500">Left to save</p>
            <p className="text-lg font-bold tabular-nums">{fmt(totalRemaining)}</p>
          </div>
        )}
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3">
          {goals === null ? (
            <p className="text-sm text-neutral-500 italic py-2">Loading…</p>
          ) : plans.length === 0 && !adding ? (
            <p className="text-sm text-neutral-500 py-2">
              Add something you're saving toward — a trip, an emergency fund, a down payment — and this works out how
              much to set aside each month from what your budget actually leaves free.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-800">
              {plans.map((p) => (
                <GoalRow
                  key={p.id}
                  plan={p}
                  fmt={fmt}
                  onContribute={(amount) => patchGoal(p.id, { addSaved: amount })}
                  onSave={(patch) => patchGoal(p.id, patch)}
                  onDelete={() => deleteGoal(p.id)}
                />
              ))}
            </ul>
          )}

          {error && <p className="text-sm text-rose-400">{error}</p>}

          {adding ? (
            <GoalForm onCancel={() => setAdding(false)} onSave={createGoal} />
          ) : (
            <button onClick={() => setAdding(true)} className="text-sm text-neutral-400 hover:text-white">
              + Add a goal
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function GoalForm({
  initial,
  onCancel,
  onSave,
}: {
  initial?: { name: string; targetAmount: number; targetDate: string | null };
  onCancel: () => void;
  onSave: (input: { name: string; targetAmount: number; targetDate: string | null }) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [targetAmount, setTargetAmount] = useState(initial ? String(initial.targetAmount) : "");
  const [targetDate, setTargetDate] = useState(initial?.targetDate ? initial.targetDate.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = "px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none text-sm";

  async function save() {
    const amount = parseFloat(targetAmount);
    if (!name.trim() || !Number.isFinite(amount) || amount <= 0) {
      setError("A goal needs a name and a target amount.");
      return;
    }
    setBusy(true);
    const ok = await onSave({ name: name.trim(), targetAmount: amount, targetDate: targetDate || null });
    setBusy(false);
    if (!ok) setError("Failed to save — try again.");
  }

  return (
    <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/80 p-3">
      <div className="grid grid-cols-[1fr_7rem] gap-2">
        <input className={input} placeholder="Goal name (e.g. Emergency fund)" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className={`${input} tabular-nums`}
          placeholder="Target"
          inputMode="decimal"
          value={targetAmount}
          onChange={(e) => setTargetAmount(e.target.value)}
        />
      </div>
      <div>
        <label className="block text-xs text-neutral-500 mb-1">Target date (optional)</label>
        <input
          type="date"
          className={`${input} w-full`}
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="flex-1 py-2 rounded-lg bg-gradient-to-b from-red-500 to-red-600 hover:to-red-500 text-neutral-950 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save goal"}
        </button>
        <button onClick={onCancel} className="px-4 py-2 rounded-lg border border-neutral-700 text-sm hover:bg-neutral-800">
          Cancel
        </button>
      </div>
    </div>
  );
}

function GoalRow({
  plan,
  fmt,
  onContribute,
  onSave,
  onDelete,
}: {
  plan: ReturnType<typeof planSavingsGoal>;
  fmt: Formatter;
  onContribute: (amount: number) => Promise<boolean>;
  onSave: (patch: { name: string; targetAmount: number; targetDate: string | null }) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [addingMoney, setAddingMoney] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  if (editing) {
    return (
      <li className="py-3">
        <GoalForm
          initial={{ name: plan.name, targetAmount: plan.targetAmount, targetDate: plan.targetDate }}
          onCancel={() => setEditing(false)}
          onSave={async (input) => {
            const ok = await onSave(input);
            if (ok) setEditing(false);
            return ok;
          }}
        />
      </li>
    );
  }

  const paceLine = plan.done
    ? "🎉 Goal reached"
    : plan.requiredMonthly != null
    ? `Save ${fmt(plan.requiredMonthly)}/mo to hit it${plan.monthsLeft === 1 ? " this month" : ` in ~${plan.monthsLeft} months`}`
    : plan.projectedDate
    ? `At today's free-to-spend pace, you'd hit it by ${new Date(plan.projectedDate).toLocaleDateString(undefined, { month: "long", year: "numeric" })}`
    : "Add a target date, or free up some monthly money, to get a pace";

  const chip =
    plan.done
      ? "bg-neutral-500/15 text-neutral-200 border-neutral-500/30"
      : plan.fitsFreeToSpend === false
      ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
      : plan.fitsFreeToSpend === true
      ? "bg-neutral-500/15 text-neutral-200 border-neutral-500/30"
      : "bg-neutral-800 text-neutral-500 border-neutral-700";

  async function submitContribution() {
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n === 0) return;
    setBusy(true);
    const ok = await onContribute(n);
    setBusy(false);
    if (ok) {
      setAmount("");
      setAddingMoney(false);
    }
  }

  return (
    <li className="py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium break-words">{plan.name}</p>
          <p className="text-xs text-neutral-500">
            {fmt(plan.savedAmount)} of {fmt(plan.targetAmount)} saved · {plan.progressPct.toFixed(0)}%
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0 text-neutral-500">
          <button onClick={() => setAddingMoney((v) => !v)} className="px-2 py-1 text-xs hover:text-white" title="Add money">
            + Add
          </button>
          <button onClick={() => setEditing(true)} className="px-2 py-1 text-xs hover:text-white" title="Edit goal">
            Edit
          </button>
          <button onClick={onDelete} className="px-2 py-1 text-xs hover:text-rose-300" title="Delete goal">
            ✕
          </button>
        </div>
      </div>

      <div className="h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden">
        <div className="h-full bg-red-500 rounded-full transition-all" style={{ width: `${plan.progressPct}%` }} />
      </div>

      <span className={`inline-block text-xs px-2 py-1 rounded border ${chip}`}>{paceLine}</span>

      {addingMoney && (
        <div className="flex gap-2 pt-1">
          <input
            autoFocus
            className="flex-1 px-3 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 focus:border-red-500 outline-none text-sm tabular-nums"
            placeholder="Amount saved (e.g. 50)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitContribution()}
          />
          <button
            onClick={submitContribution}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-red-500 text-neutral-950 text-sm font-semibold disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}
    </li>
  );
}

function StatCard({
  label,
  value,
  accent,
  sub,
  onEdit,
  action,
}: {
  label: string;
  value: string;
  accent: "red" | "rose" | "maroon" | "highlight" | "crimson";
  sub?: string;
  onEdit?: () => void;
  action?: { label: string; busy?: boolean; onClick: () => void };
}) {
  const colors: Record<string, string> = {
    red: "from-red-500/20 to-red-500/0 border-red-500/30",
    rose: "from-rose-500/20 to-rose-500/0 border-rose-500/30",
    maroon: "from-rose-700/20 to-rose-700/0 border-rose-700/30",
    highlight: "from-neutral-400/20 to-neutral-400/0 border-neutral-400/30",
    crimson: "from-red-600/20 to-red-600/0 border-red-600/30",
  };
  return (
    <div className={`relative bg-gradient-to-br ${colors[accent]} border rounded-2xl p-3 md:p-4`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs uppercase tracking-wider opacity-80">{label}</p>
        {action && (
          <button
            onClick={action.onClick}
            disabled={action.busy}
            title={action.label}
            aria-label={action.label}
            className="text-neutral-400 hover:text-white -mt-1.5 -mr-1.5 p-1.5 disabled:opacity-60"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={action.busy ? "animate-spin" : ""}
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />
            </svg>
          </button>
        )}
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
      <p className="text-lg sm:text-2xl font-bold mt-1 md:mt-2 tabular-nums text-white">{value}</p>
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
  pctOfIncome?: number;
  color: "red" | "rose" | "maroon" | "crimson" | "neutral";
  note?: string;
}) {
  const fmt = useContext(CurrencyContext);
  const map = {
    red: "text-red-400",
    rose: "text-rose-400",
    maroon: "text-rose-600",
    crimson: "text-red-500",
    neutral: "text-neutral-300",
  };
  return (
    <tr className="hover:bg-neutral-800/30">
      <td className="px-5 py-3 font-medium">{label}</td>
      <td className="px-5 py-3 text-right text-neutral-400">{count}</td>
      <td className={`px-5 py-3 text-right tabular-nums font-semibold ${map[color]}`}>{fmt(total)}</td>
      <td className="px-5 py-3 text-right hidden sm:table-cell text-neutral-400">
        {pctOfIncome == null ? "—" : pct(pctOfIncome)}
      </td>
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
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={titles[type]}
        className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-6 px-6 pt-6 w-full max-w-md shadow-2xl max-h-[90dvh] overflow-y-auto"
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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 sm:p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${entry.label}`}
        className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-6 px-6 pt-6 w-full max-w-md shadow-2xl max-h-[90dvh] overflow-y-auto"
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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 sm:p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Adjust balance"
        className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-6 px-6 pt-6 w-full max-w-md shadow-2xl max-h-[90dvh] overflow-y-auto"
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
  onClose,
  onSaved,
  onBanksChanged,
}: {
  currency: string;
  onClose: () => void;
  onSaved: (code: string) => void;
  onBanksChanged: () => void;
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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 sm:p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[90dvh] pb-[env(safe-area-inset-bottom)] sm:pb-0"
      >
        <div className="p-6 pb-3 shrink-0">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-bold">Settings</h2>
            <div className="flex items-center gap-2">
              {/* Phones have no header Sign out button; it lives here instead. */}
              <button
                onClick={() => signOut({ callbackUrl: "/login" })}
                className="md:hidden px-3 py-1.5 rounded-lg border border-neutral-700 text-sm text-neutral-300"
              >
                Sign out
              </button>
              <button onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white text-lg leading-none p-2 -m-1">✕</button>
            </div>
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
                autoFocus={typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches}
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
          <BankTab onChanged={onBanksChanged} />
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

// The "Bank" settings tab: connect any number of banks (Plaid or SimpleFIN),
// see what's linked, sync on demand, and unlink. Connected chequing/savings
// accounts become the dashboard's Balance; cards and loans sync into debts.
function BankTab({ onChanged }: { onChanged: () => void }) {
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
        "Re-import bank transactions?\n\nThis deletes every purchase and income imported from your banks and imports them again from the banks still connected, each dated when it happened. Edits you made to imported entries are lost, and imported entries you deleted come back. Your debts aren't affected."
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
      `re-imported ${body.incomes} income, ${body.purchases} purchase${body.purchases === 1 ? "" : "s"} and ${body.circulation} circulation`,
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
          <p className="text-xs text-neutral-500">This is your Balance on the dashboard.</p>
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

      {/* Always shown: purchases imported by a since-removed connection still
          need cleaning up even when no bank is connected now. */}
      {items !== null && sfConns !== null && (
        <div className="border-t border-neutral-800 pt-4 space-y-2">
          <p className="text-xs text-neutral-500">
            Pay and deposits import as Income, spending as Purchases, and e-transfers, refunds and card
            payments as Circulation — each in the month it happened. Transfers between your own accounts
            are skipped. If you also log your pay by hand, remove that entry so it isn't counted twice.
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

      <DeleteAllData
        onDeleted={async () => {
          setReimportNotice(null);
          await Promise.all([loadItems(), loadSimplefin()]);
          onChanged();
        }}
      />
    </div>
  );
}

// SimpleFIN Bridge: the user connects banks on simplefin.org and pastes a
// one-time setup token here. SimpleFIN has no account types, so each account
// shows its guessed kind with a picker to correct it.
// Wipes every entry on the profile so bank data can be re-imported from
// scratch. Irreversible, so it asks for DELETE to be typed first.
function DeleteAllData({ onDeleted }: { onDeleted: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/data", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: typed.trim().toUpperCase() }),
    });
    setBusy(false);
    const body = await r.json().catch(() => null);
    if (!r.ok) return setError(body?.error ?? "Failed to delete");
    setOpen(false);
    setTyped("");
    setResult(
      `Deleted ${body.deleted} entr${body.deleted === 1 ? "y" : "ies"}. Tap "Fix imported transactions" to bring your bank data back.`
    );
    await onDeleted();
  }

  return (
    <div className="space-y-2">
      {result && <p className="text-sm text-neutral-300">{result}</p>}
      {!open ? (
        <button
          onClick={() => {
            setOpen(true);
            setResult(null);
          }}
          className="w-full py-2.5 rounded-xl border border-rose-500/40 text-sm text-rose-300 hover:bg-rose-500/10"
        >
          Delete all data
        </button>
      ) : (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 space-y-2">
          <p className="text-sm text-rose-200 font-semibold">Delete every entry on your profile?</p>
          <p className="text-xs text-neutral-300">
            Removes all income, bills, purchases, circulation and debts (with their payment history) and the transaction
            list. This can't be undone. Your bank connections, budget essentials and settings stay, so you can re-import
            your bank data right after.
          </p>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type DELETE to confirm"
            autoCapitalize="characters"
            autoComplete="off"
            className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-rose-500/40 focus:border-rose-400 outline-none text-sm"
          />
          {error && <p className="text-xs text-rose-300">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={run}
              disabled={busy || typed.trim().toUpperCase() !== "DELETE"}
              className="flex-1 py-2 rounded-lg bg-rose-600 text-white text-sm font-semibold disabled:opacity-40"
            >
              {busy ? "Deleting…" : "Delete everything"}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setTyped("");
                setError(null);
              }}
              className="px-4 py-2 rounded-lg border border-neutral-700 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 sm:p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={pickingDebt ? "Which card or loan?" : `Mark "${label}" as paid`}
        className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-6 px-6 pt-6 w-full max-w-md shadow-2xl max-h-[90dvh] overflow-y-auto"
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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 sm:p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Payments — ${label}`}
        className="bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-6 px-6 pt-6 w-full max-w-md shadow-2xl max-h-[90dvh] overflow-y-auto"
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

