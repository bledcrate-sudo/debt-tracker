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
};

export const IMPORT_NOTE = "Synced from bank";
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

export type ImportCounts = { purchases: number; incomes: number; transfers: number };

// Imports money out as one-off purchases and money in as one-off income,
// dated when they happened so the ledger files them under the right month.
// Each transaction is imported at most once: markImported writes the
// provider's dedupe row in the same DB transaction as the Entry, and a
// duplicate key (P2002) rolls the Entry back.
export async function importBankTransactions(opts: {
  userId: string;
  txns: BankTxn[];
  alreadyImported: (keys: string[]) => Promise<Set<string>>;
  markImported: (tx: Prisma.TransactionClient, key: string) => Promise<unknown>;
}): Promise<ImportCounts> {
  const counts: ImportCounts = { purchases: 0, incomes: 0, transfers: 0 };
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
    try {
      await prisma.$transaction(async (tx) => {
        await opts.markImported(tx, t.key);
        if (skipAsTransfer) return;
        await tx.entry.create({
          data: {
            userId: opts.userId,
            type: t.amount < 0 ? "purchase" : "income",
            label: (t.label || "Bank transaction").slice(0, 120),
            amount: roundCents(Math.abs(t.amount)),
            frequency: "once",
            // Only purchases carry a payment source.
            sourceKind: t.amount < 0 ? "balance" : null,
            note: IMPORT_NOTE,
            createdAt: t.date,
          },
        });
      });
      if (skipAsTransfer) counts.transfers++;
      else if (t.amount < 0) counts.purchases++;
      else counts.incomes++;
    } catch (e: any) {
      if (e?.code !== "P2002") throw e; // already imported
    }
  }
  return counts;
}
