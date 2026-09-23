// Finds subscriptions and other recurring charges in the purchase history:
// the same merchant charging roughly the same amount on a roughly monthly
// cadence. Purely a read over past BankTransaction rows — nothing is stored,
// so it's recomputed each time (cheap: a few hundred rows at most) and never
// goes stale.
export type RecurringTxn = { label: string; amount: number; date: Date };

export type RecurringCharge = {
  label: string; // as it last appeared
  amount: number; // most recent amount
  occurrences: number;
  lastDate: Date;
  avgIntervalDays: number;
  monthlyAmount: number; // normalized to a monthly cost, for the total
};

// Store codes, transaction numbers and card-last-4 digits vary run to run
// ("SOBEYS #123", "TIM HORTONS #4521", "AMAZON.CA*A1B2C3") — strip trailing
// numbers/codes so the same merchant groups together.
function normalize(label: string): string {
  return label
    .toLowerCase()
    .replace(/\*[a-z0-9]+$/i, "")
    .replace(/#?\s*\d[\d-]*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const MIN_GAP_DAYS = 22;
const MAX_GAP_DAYS = 40;
const MAX_AMOUNT_DRIFT = 0.08; // 8% — covers small price bumps and tax rounding

// Groups purchases by normalized merchant, then looks for at least two
// consecutive charges spaced ~monthly apart with a similar amount. Returns
// the merchants that qualify, newest first.
export function detectRecurring(txns: RecurringTxn[]): RecurringCharge[] {
  const groups = new Map<string, RecurringTxn[]>();
  for (const t of txns) {
    const key = normalize(t.label);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }

  const out: RecurringCharge[] = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.date.getTime() - b.date.getTime());
    // Walk the sorted charges, keeping a run of ones that are both spaced
    // like a monthly bill and close enough in amount to the one before.
    let run: RecurringTxn[] = [rows[0]];
    const flush = () => {
      if (run.length >= 2) {
        const last = run[run.length - 1];
        const gaps = run.slice(1).map((t, i) => (t.date.getTime() - run[i].date.getTime()) / 86400_000);
        const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
        out.push({
          label: last.label,
          amount: Math.abs(last.amount),
          occurrences: run.length,
          lastDate: last.date,
          avgIntervalDays: Math.round(avgGap),
          // A ~30-day charge is already monthly; a longer cadence (e.g.
          // quarterly) is spread across its months for the monthly total.
          monthlyAmount: Math.abs(last.amount) * Math.min(1, 30 / avgGap),
        });
      }
      run = [];
    };
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      const gapDays = (cur.date.getTime() - prev.date.getTime()) / 86400_000;
      const drift = Math.abs(Math.abs(cur.amount) - Math.abs(prev.amount)) / Math.max(Math.abs(prev.amount), 0.01);
      if (gapDays >= MIN_GAP_DAYS && gapDays <= MAX_GAP_DAYS && drift <= MAX_AMOUNT_DRIFT) {
        run.push(cur);
      } else {
        flush();
        run = [cur];
      }
    }
    flush();
  }
  return out.sort((a, b) => b.lastDate.getTime() - a.lastDate.getTime());
}
