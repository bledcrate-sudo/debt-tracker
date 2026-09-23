import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { roundCents } from "./money";
import { guessCategory } from "./categorize";

// One posted transaction from a cash (chequing/savings) account, normalized
// across providers. amount > 0 is money in, amount < 0 is money out.
export type BankTxn = {
  key: string; // provider dedupe key
  account: string; // which of the user's accounts it's on
  amount: number;
  date: Date;
  // Display name (a provider's cleaned-up payee when it has one).
  label: string;
  // The bank's own description. Rules match it too: the payee can hide the
  // words that matter (TD's "VFC..." e-transfers come through SimpleFIN with
  // a payee like "ATM Deposit"; pay can come as just the employer's name).
  raw?: string;
  // Provider's own categorization when it has one (Plaid does), which beats
  // guessing from the description.
  hint?: TxnKind;
  // Shown in the merged transactions feed.
  institution?: string | null;
  accountName?: string;
  // Set for transactions on a credit card / loan: the debt Entry it's
  // tracked as. Purchases on it are "on card" — spending, but not out of the
  // cash balance, and not added to the debt again (the card's balance sync
  // already records what's owed).
  cardEntryId?: string | null;
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

// E-transfers and other transfers ("e-Transfer sent", "SEND E-TFR", "Online
// Banking transfer", Desjardins' "Virement Interac"). Not bare "Interac":
// debit card purchases say it too ("Interac purchase - 1234 STORE" at RBC,
// "INTERAC RETAIL PURCHASE"), and those are spending.
const ETRANSFER = /e-?\s?transfer|\btransfer\b|\be-?tfr\b|\btfr\b|virement|auto-?deposit|send money|money request|request money/i;
// TD marks Interac e-Transfers with "VFC" (e.g. "VFC1234567 SAM SMITH"),
// which the rules below would otherwise read as a deposit (income). Matched
// at any bank: nothing else uses the code, and the bank's name isn't always
// reported the same way ("TD Canada Trust", "td.com"...).
const VFC_ETRANSFER = /\bvfc/i;

const textOf = (t: Pick<BankTxn, "label" | "raw">) => [t.raw, t.label].filter(Boolean).join(" ");
export const isVfcEtransfer = (t: Pick<BankTxn, "label" | "raw">) => VFC_ETRANSFER.test(textOf(t));
const PAY_IN = /payroll|salary|wages|pay\s?(cheque|check)|direct dep|dir dep|\bdeposit\b|\bdep\b|\bpay\b/i;
// "PAY"/"DEPOSIT" also appear in refunds and wallet payments — not pay.
const NOT_PAY = /apple pay|google pay|samsung pay|paypal|refund|reversal|return/i;
const PAYMENT = /\b(payment|pymt|pmt|paiement)\b/i;
const DEBT_ACCOUNT = /visa|master ?card|\bmc\b|amex|american express|credit card|\bcc\b|loan|line of credit|\bloc\b|mortgage/i;

// Sorts a transaction by its description. Keyword-based, so an odd bank
// description can land in the wrong section.
export function classifyTxn(t: Pick<BankTxn, "amount" | "label" | "raw" | "hint" | "cardEntryId">): TxnKind {
  // Both the payee and the bank's description, so neither hides the other.
  const label = textOf(t);
  // Checked before the provider's own category: these are e-transfers.
  if (VFC_ETRANSFER.test(label)) return "circulation";
  // Money arriving on a card is a payment or refund, never pay.
  if (t.cardEntryId && t.amount > 0) return "circulation";
  if (t.hint) return t.hint;
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
  provider: "plaid" | "simplefin";
  txns: BankTxn[];
  alreadyImported: (keys: string[]) => Promise<Set<string>>;
  markImported: (tx: Prisma.TransactionClient, key: string) => Promise<unknown>;
}): Promise<ImportCounts> {
  const counts: ImportCounts = { purchases: 0, incomes: 0, circulation: 0, transfers: 0 };
  const txns = opts.txns.filter((t) => Number.isFinite(t.amount) && roundCents(t.amount) !== 0);
  if (txns.length === 0) return counts;

  const partners = findTransferPairs(txns);
  const before = await opts.alreadyImported(txns.map((t) => t.key));
  // Row for the merged transactions feed (every transaction, transfers too).
  const feedRow = (t: BankTxn, kind: TxnKind | "transfer", entryId: string | null) => ({
    userId: opts.userId,
    provider: opts.provider,
    key: t.key,
    institution: t.institution ?? null,
    account: t.accountName || "Account",
    date: t.date,
    amount: roundCents(t.amount),
    description: (t.raw || t.label || "Bank transaction").slice(0, 200),
    kind,
    // Only purchases get a spending category; income/circulation/transfer
    // rows aren't grouped by merchant.
    category: kind === "purchase" ? guessCategory(t.raw || t.label || "") : null,
    entryId,
  });

  // Imported before the feed existed: add them to it (unlinked), so the feed
  // fills in as syncs re-read recent history. A re-import links everything.
  const backfill = txns
    .filter((t) => before.has(t.key))
    .map((t) => feedRow(t, partners.has(t.key) ? "transfer" : classifyTxn(t), null));
  if (backfill.length) await prisma.bankTransaction.createMany({ data: backfill, skipDuplicates: true });

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
        const record = (kind: TxnKind | "transfer", entryId: string | null) => {
          const row = feedRow(t, kind, entryId);
          return tx.bankTransaction.upsert({
            where: { provider_key: { provider: row.provider, key: row.key } },
            create: row,
            update: { kind, entryId, category: row.category },
          });
        };
        if (skipAsTransfer) {
          await record("transfer", null);
          return;
        }
        const entry = await tx.entry.create({
          data: {
            userId: opts.userId,
            type: kind,
            // A VFC e-transfer's payee is wrong ("ATM Deposit"); show the bank's text.
            label: ((isVfcEtransfer(t) ? t.raw : null) || t.label || t.raw || "Bank transaction").slice(0, 120),
            amount: roundCents(Math.abs(t.amount)),
            frequency: "once",
            // Purchases: paid from balance, or on the card they were made
            // with. Circulation: which way it moved (amounts are stored
            // positive). No charge is raised on the card's debt for an
            // on-card purchase: its balance sync already counts it.
            sourceKind:
              kind === "purchase"
                ? t.cardEntryId
                  ? "debt"
                  : "balance"
                : kind === "circulation"
                ? t.amount > 0
                  ? "in"
                  : "out"
                : null,
            debtEntryId: kind === "purchase" && t.cardEntryId ? t.cardEntryId : null,
            note: IMPORT_NOTE,
            createdAt: t.date,
          },
        });
        await record(kind, entry.id);
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
