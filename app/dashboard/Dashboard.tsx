"use client";
import { useMemo, useState } from "react";
import { signOut } from "next-auth/react";

type EntryType = "income" | "expense" | "debt";

type Entry = {
  id: string;
  type: string;
  label: string;
  amount: number;
  frequency: string;
  note: string | null;
  createdAt: string;
};

const fmt = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function Dashboard({
  initialEntries,
  userEmail,
  userName,
}: {
  initialEntries: Entry[];
  userEmail: string;
  userName: string | null;
}) {
  const [entries, setEntries] = useState<Entry[]>(initialEntries);
  const [modalType, setModalType] = useState<EntryType | null>(null);
  const [busy, setBusy] = useState(false);
  const [strategy, setStrategy] = useState<"avalanche" | "snowball">("avalanche");
  const [payoutPct, setPayoutPct] = useState(50);

  const income = useMemo(() => entries.filter((e) => e.type === "income"), [entries]);
  const expenses = useMemo(() => entries.filter((e) => e.type === "expense"), [entries]);
  const debts = useMemo(() => entries.filter((e) => e.type === "debt"), [entries]);

  const sumBy = (arr: Entry[], pred?: (e: Entry) => boolean) =>
    arr.reduce((s, e) => s + (!pred || pred(e) ? e.amount : 0), 0);
  const totalIncome = useMemo(() => sumBy(income), [income]);
  const totalExpense = useMemo(() => sumBy(expenses), [expenses]);
  const totalDebt = useMemo(() => sumBy(debts), [debts]);
  const monthlyIncome = useMemo(() => sumBy(income, (e) => e.frequency === "monthly"), [income]);
  const monthlyExpense = useMemo(() => sumBy(expenses, (e) => e.frequency === "monthly"), [expenses]);
  const oneTimeIncome = totalIncome - monthlyIncome;
  const oneTimeExpense = totalExpense - monthlyExpense;
  const monthlySurplus = monthlyIncome - monthlyExpense;
  const surplus = totalIncome - totalExpense;
  const balance = surplus - totalDebt;
  const dti = monthlyIncome > 0 ? totalDebt / (monthlyIncome * 12) : 0;
  const monthlyToDebt = Math.max(0, monthlySurplus * (payoutPct / 100));
  const monthsToClear = monthlyToDebt > 0 ? Math.ceil(totalDebt / monthlyToDebt) : Infinity;

  const payoffOrder = useMemo(() => {
    const arr = [...debts];
    if (strategy === "avalanche") arr.sort((a, b) => b.amount - a.amount);
    else arr.sort((a, b) => a.amount - b.amount);
    let remaining = monthlyToDebt;
    let monthCursor = 0;
    return arr.map((d) => {
      const months = remaining > 0 ? Math.ceil(d.amount / remaining) : Infinity;
      monthCursor += months;
      return { ...d, months, eta: monthCursor };
    });
  }, [debts, strategy, monthlyToDebt]);

  async function addEntry(payload: { type: EntryType; label: string; amount: number; frequency: "once" | "monthly"; note?: string }) {
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
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">
            Hello, <span className="text-emerald-400">{userName || userEmail.split("@")[0]}</span>
          </h1>
          <p className="text-slate-400 text-sm">Your money, tracked.</p>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="px-4 py-2 rounded-xl border border-slate-700 hover:bg-slate-800 transition text-sm"
        >
          Sign out
        </button>
      </header>

      {/* Summary cards */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Balance" value={fmt(balance)} accent={balance >= 0 ? "emerald" : "rose"} />
        <StatCard label="Income" value={fmt(totalIncome)} accent="emerald" />
        <StatCard label="Expenses" value={fmt(totalExpense)} accent="rose" />
        <StatCard label="Debt" value={fmt(totalDebt)} accent="amber" />
        <StatCard
          label="Monthly surplus"
          value={fmt(monthlySurplus)}
          accent={monthlySurplus >= 0 ? "sky" : "rose"}
          sub={`Recurring · DTI ${pct(dti)}`}
        />
      </section>

      {/* Three category tables */}
      <section className="grid lg:grid-cols-3 gap-6">
        <CategoryTable
          title="Income"
          color="emerald"
          rows={income}
          total={totalIncome}
          onAdd={() => setModalType("income")}
          onDelete={deleteEntry}
        />
        <CategoryTable
          title="Expenses"
          color="rose"
          rows={expenses}
          total={totalExpense}
          onAdd={() => setModalType("expense")}
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
              label="Expenses"
              count={expenses.length}
              total={-totalExpense}
              pctOfIncome={totalIncome ? -totalExpense / totalIncome : 0}
              color="rose"
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
                Income − Expenses − Debt
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
                AI-style
              </span>
            </h2>
            <p className="text-slate-400 text-sm">
              Driven by your <span className="text-sky-300">monthly recurring</span> surplus ({fmt(monthlySurplus)}/mo).
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

        <div className="grid sm:grid-cols-3 gap-3 mb-5">
          <MiniStat label="Apply to debt / mo" value={fmt(monthlyToDebt)} />
          <MiniStat
            label="Months to debt-free"
            value={monthsToClear === Infinity ? "∞" : `${monthsToClear} mo`}
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
                  <th className="text-right px-4 py-3 hidden sm:table-cell">Share</th>
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
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-amber-300">{fmt(d.amount)}</td>
                    <td className="px-4 py-3 text-right hidden sm:table-cell text-slate-400">
                      {totalDebt ? pct(d.amount / totalDebt) : "—"}
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
}: {
  title: string;
  color: "emerald" | "rose" | "amber";
  rows: Entry[];
  total: number;
  onAdd: () => void;
  onDelete: (id: string) => void;
  showShare?: boolean;
}) {
  const map = {
    emerald: { bar: "bg-emerald-500", text: "text-emerald-400", chip: "bg-emerald-500/15 border-emerald-500/30", btn: "bg-emerald-500 hover:bg-emerald-400 text-slate-950" },
    rose: { bar: "bg-rose-500", text: "text-rose-400", chip: "bg-rose-500/15 border-rose-500/30", btn: "bg-rose-500 hover:bg-rose-400 text-white" },
    amber: { bar: "bg-amber-500", text: "text-amber-400", chip: "bg-amber-500/15 border-amber-500/30", btn: "bg-amber-500 hover:bg-amber-400 text-slate-950" },
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
              <th className="px-4 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.length === 0 && (
              <tr>
                <td colSpan={showShare ? 4 : 3} className="text-center py-8 text-slate-500 italic">
                  Empty — click + Add
                </td>
              </tr>
            )}
            {rows.map((e) => (
              <tr key={e.id} className="hover:bg-slate-800/40">
                <td className="px-4 py-2.5">
                  <p className="font-medium truncate flex items-center gap-2">
                    {e.label}
                    <span
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        e.frequency === "monthly"
                          ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                          : "bg-slate-700/50 text-slate-400 border border-slate-600/40"
                      }`}
                    >
                      {e.frequency === "monthly" ? "Monthly" : "Once"}
                    </span>
                  </p>
                  {e.note && <p className="text-xs text-slate-500 truncate">{e.note}</p>}
                </td>
                <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${map.text}`}>
                  {fmt(e.amount)}
                </td>
                {showShare && (
                  <td className="px-4 py-2.5 text-right text-slate-400 tabular-nums">
                    {total ? pct(e.amount / total) : "—"}
                  </td>
                )}
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => onDelete(e.id)}
                    className="text-slate-500 hover:text-rose-400"
                    title="Delete"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
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
  accent: "emerald" | "rose" | "amber" | "sky";
  sub?: string;
}) {
  const colors: Record<string, string> = {
    emerald: "from-emerald-500/20 to-emerald-500/0 border-emerald-500/30",
    rose: "from-rose-500/20 to-rose-500/0 border-rose-500/30",
    amber: "from-amber-500/20 to-amber-500/0 border-amber-500/30",
    sky: "from-sky-500/20 to-sky-500/0 border-sky-500/30",
  };
  return (
    <div className={`bg-gradient-to-br ${colors[accent]} border rounded-2xl p-4`}>
      <p className="text-xs uppercase tracking-wider opacity-80">{label}</p>
      <p className="text-2xl font-bold mt-2 tabular-nums text-white">{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
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
  color: "emerald" | "rose" | "amber";
  note?: string;
}) {
  const map = { emerald: "text-emerald-400", rose: "text-rose-400", amber: "text-amber-400" };
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
  onSubmit: (p: { type: EntryType; label: string; amount: number; frequency: "once" | "monthly"; note?: string }) => void;
  busy: boolean;
}) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [frequency, setFrequency] = useState<"once" | "monthly">(type === "debt" ? "once" : "monthly");

  const titles: Record<EntryType, string> = {
    income: "Add income",
    expense: "Add expense",
    debt: "Add debt",
  };

  const hints: Record<EntryType, { once: string; monthly: string }> = {
    income: { once: "Bonus, gift, refund — counted once", monthly: "Salary, paycheck — repeats every month" },
    expense: { once: "Single purchase — counted once", monthly: "Rent, subscriptions — repeats every month" },
    debt: { once: "Outstanding balance to pay off", monthly: "Recurring debt payment / installment" },
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = parseFloat(amount);
    if (!label.trim() || isNaN(n) || n <= 0) return;
    onSubmit({ type, label: label.trim(), amount: n, frequency, note: note.trim() || undefined });
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
          <input
            autoFocus
            placeholder="Label (e.g. Salary, Rent, Credit card)"
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

/* ---------- helpers ---------- */

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
