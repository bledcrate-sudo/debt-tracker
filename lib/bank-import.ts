import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { roundCents } from "./money";

// One posted transaction from a cash (chequing/savings) account, normalized
// across providers. amount > 0 is money in, amount < 0 is money out.
export type BankTxn = {
  key: string; // provider dedupe key
  account: string; // which of the user's accounts it's on
  amount: number;
  date: Date;
  label: string;
  // Provider's own categorization when it has one (Plaid does), which beats
  // guessing from the description.
  hint?: TxnKind;
};

// income: pay and deposits. purchase: spending. circulation: money moving
// around that is neither — e-transfers either way, refunds, card/loan
// payments (the spending already happened on the card, which is tracked as
// a debt). Circulation moves the bank balance but stays out of income and
// spending totals, so those reflect what was actually earned and spent.
export type TxnKind = "income" | "purchase" | "circulation";

export { IMPORT_NOTE } from "./constants";
import { IMPORT_NOTE } from "./constants";
// Entry types the importers create (debts are created by the account sync).
export const IMPORTED_TYPES = ["purchase", "income", "circulation"];

const ETRANSFER = /e-?\s?transfer|\be-?tfr\b|interac|auto-?deposit|send money|money request|request money/i;
const PAY_IN = /payroll|salary|wages|pay\s?(cheque|check)|direct dep|dir dep|\bdeposit\b|\bdep\b|\bpay\b/i;
// "PAY"/"DEPOSIT" also appear in refunds and wallet payments — not pay.
const NOT_PAY = /apple pay|google pay|samsung pay|paypal|refund|reversal|return/i;
const PAYMENT = /\b(payment|pymt|pmt|paiement)\b/i;
const DEBT_ACCOUNT = /visa|master ?card|\bmc\b|amex|american express|credit card|\bcc\b|loan|line of credit|\bloc\b|mortgage/i;

// Sorts a transaction by its description. Keyword-based, so an odd bank
// description can land in the wrong section.
export function classifyTxn(t: Pick<BankTxn, "amount" | "label" | "hint">): TxnKind {
  if (t.hint) return t.hint;
  const label = t.label ?? "";
  if (ETRANSFER.test(label)) return "circulation";
  if (t.amount > 0) return PAY_IN.test(label) && !NOT_PAY.test(label) ? "income" : "circulation";
  return PAYMENT.test(label) && DEBT_ACCOUNT.test(label) ? "circulation" : "purchase";
}

const TRANSFER_WINDOW_MS = 3 * 86400_000;

// Money moved between two of the user's own accounts shows up as an outflow
// on one and an equal inflow on the other. Counting it would book the same
// dollars as both spending and income, so pair them up (same amount to the
// cent, different accounts, within a few days) and treat both as transfers.
// Returns each paired key mapped to its partner's key.
export function findTransferPairs(txns: BankTxn[]): Map<string, string> {
  const pairs = new Map<string, string>();
  const inflows = txns.filter((t) => t.amount > 0).sort((a, b) => a.date.getTime() - b.date.getTime());
  const outflows = txns.filter((t) => t.amount < 0).sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const out of outflows) {
    const match = inflows.find(
      (inn) =>
        !pairs.has(inn.key) &&
        inn.account !== out.account &&
        Math.round(inn.amount * 100) === Math.round(-out.amount * 100) &&
        Math.abs(inn.date.getTime() - out.date.getTime()) <= TRANSFER_WINDOW_MS
    );
    if (match) {
      pairs.set(out.key, match.key);
      pairs.set(match.key, out.key);
    }
  }
  return pairs;
}

export type ImportCounts = { purchases: number; incomes: number; circulation: number; transfers: number };

// Imports each transaction as a one-off income, purchase, or circulation
// entry (see classifyTxn), dated when it happened so the ledger files it
// under the right month.
// Each transaction is imported at most once: markImported writes the
// provider's dedupe row in the same DB transaction as the Entry, and a
// duplicate key (P2002) rolls the Entry back.
export async function importBankTransactions(opts: {
  userId: string;
  txns: BankTxn[];
  alreadyImported: (keys: string[]) => Promise<Set<string>>;
  markImported: (tx: Prisma.TransactionClient, key: string) => Promise<unknown>;
}): Promise<ImportCounts> {
  const counts: ImportCounts = { purchases: 0, incomes: 0, circulation: 0, transfers: 0 };
  const txns = opts.txns.filter((t) => Number.isFinite(t.amount) && roundCents(t.amount) !== 0);
  if (txns.length === 0) return counts;

  const partners = findTransferPairs(txns);
  const before = await opts.alreadyImported(txns.map((t) => t.key));

  for (const t of txns) {
    if (before.has(t.key)) continue;
    const partner = partners.get(t.key);
    // A transfer is recorded as handled without an Entry — unless its other
    // side was already imported as spending/income by an earlier sync, in
    // which case import this side too so the two still cancel out.
    const skipAsTransfer = partner !== undefined && !before.has(partner);
    const kind = classifyTxn(t);
    try {
      await prisma.$transaction(async (tx) => {
        await opts.markImported(tx, t.key);
        if (skipAsTransfer) return;
        await tx.entry.create({
          data: {
            userId: opts.userId,
            type: kind,
            label: (t.label || "Bank transaction").slice(0, 120),
            amount: roundCents(Math.abs(t.amount)),
            frequency: "once",
            // Purchases: paid from balance. Circulation: which way it moved
            // (amounts are stored positive).
            sourceKind: kind === "purchase" ? "balance" : kind === "circulation" ? (t.amount > 0 ? "in" : "out") : null,
            note: IMPORT_NOTE,
            createdAt: t.date,
          },
        });
      });
      if (skipAsTransfer) counts.transfers++;
      else if (kind === "purchase") counts.purchases++;
      else if (kind === "income") counts.incomes++;
      else counts.circulation++;
    } catch (e: any) {
      if (e?.code !== "P2002") throw e; // already imported
    }
  }
  return counts;
}
