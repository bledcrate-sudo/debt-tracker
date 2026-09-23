import type { Transaction } from "plaid";
import { plaidClient } from "./plaid";
import { prisma } from "./prisma";
import { decryptToken } from "./plaid-crypto";
import { roundCents } from "./money";
import { importBankTransactions, type BankTxn, type TxnKind } from "./bank-import";

export type SyncSummary = {
  accountsSeen: number;
  debtsCreated: number;
  debtsUpdated: number;
  transactionsImported: number;
  incomesImported: number;
  circulationImported: number;
  transfersSkipped: number;
  // Sum of current depository (checking/savings) balances this sync saw,
  // null if the item has no depository accounts. Surfaced to the user to
  // apply manually — see the note on why this isn't written automatically.
  depositoryBalance: number | null;
};

// Plaid's own categories where they settle it; otherwise the description
// decides (lib/bank-import.ts classifyTxn). Cash/cheque deposits count as
// income, matching the description rules.
function plaidHint(t: Transaction): TxnKind | undefined {
  const pfc = t.personal_finance_category;
  if (!pfc) return undefined;
  if (pfc.primary === "INCOME" || pfc.detailed === "TRANSFER_IN_DEPOSIT") return "income";
  if (["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"].includes(pfc.primary)) return "circulation";
  return undefined;
}

// Only import transactions from the last month on a fresh connection —
// otherwise a first sync can dump a year+ of history into the ledger.
const TRANSACTION_LOOKBACK_DAYS = 30;

// Pulls the latest accounts/balances/liabilities/transactions for one linked
// Item and reconciles them into the app's existing Entry model:
//   - credit/loan accounts become (or update) a debt Entry. The balance is
//     never overwritten directly — a charge/payment DebtPayment is recorded
//     for the delta, so payoff history recorded in the app stays intact.
//   - depository accounts don't get an Entry of their own (this app tracks
//     one running cash balance, not per-account); their balance is returned
//     for the caller to display, and their posted transactions import as
//     one-off purchases (money out) or income (money in), skipping transfers
//     between the user's own accounts — see lib/bank-import.ts.
export async function syncPlaidItem(plaidItemId: string, userId: string): Promise<SyncSummary> {
  const item = await prisma.plaidItem.findUnique({
    where: { id: plaidItemId },
    include: { accounts: true },
  });
  if (!item || item.userId !== userId) throw new Error("Plaid item not found");

  const accessToken = decryptToken(item.accessToken);
  const summary: SyncSummary = {
    accountsSeen: 0,
    debtsCreated: 0,
    debtsUpdated: 0,
    transactionsImported: 0,
    incomesImported: 0,
    circulationImported: 0,
    transfersSkipped: 0,
    depositoryBalance: null,
  };

  const accountsRes = await plaidClient.accountsGet({ access_token: accessToken });
  const accounts = accountsRes.data.accounts;
  summary.accountsSeen = accounts.length;

  // Liabilities isn't available for every institution/account combo — best
  // effort, and a debt Entry still gets created from the balance alone.
  let creditByAccount = new Map<string, { apr: number | null; minPayment: number | null; dueDay: number | null }>();
  try {
    const liabRes = await plaidClient.liabilitiesGet({ access_token: accessToken });
    for (const cc of liabRes.data.liabilities.credit ?? []) {
      if (!cc.account_id) continue;
      const apr =
        cc.aprs.find((a) => a.apr_type === "purchase_apr")?.apr_percentage ??
        cc.aprs[0]?.apr_percentage ??
        null;
      const dueDay = cc.next_payment_due_date
        ? new Date(`${cc.next_payment_due_date}T00:00:00`).getDate()
        : null;
      creditByAccount.set(cc.account_id, { apr, minPayment: cc.minimum_payment_amount, dueDay });
    }
  } catch {
    /* liabilities not available on this Item — fine, skip enrichment */
  }

  let depositorySum = 0;
  let sawDepository = false;

  for (const acct of accounts) {
    const current = acct.balances.current ?? acct.balances.available ?? 0;
    const existing = item.accounts.find((a) => a.accountId === acct.account_id);

    if (acct.type === "depository") {
      sawDepository = true;
      depositorySum += acct.balances.available ?? acct.balances.current ?? 0;
      await prisma.plaidAccount.upsert({
        where: { accountId: acct.account_id },
        create: {
          plaidItemId: item.id,
          accountId: acct.account_id,
          name: acct.name,
          mask: acct.mask,
          type: acct.type,
          subtype: acct.subtype,
          lastBalance: current,
          lastSyncedAt: new Date(),
        },
        update: { name: acct.name, mask: acct.mask, lastBalance: current, lastSyncedAt: new Date() },
      });
      continue;
    }

    if (acct.type === "credit" || acct.type === "loan") {
      const liab = creditByAccount.get(acct.account_id);

      if (existing?.entryId) {
        const prevBalance = existing.lastBalance ?? current;
        const delta = roundCents(current - prevBalance);
        if (Math.abs(delta) >= 0.01) {
          await prisma.debtPayment.create({
            data: {
              entryId: existing.entryId,
              amount: Math.abs(delta),
              kind: delta > 0 ? "charge" : "payment",
              fromBalance: false,
              note: "Synced from bank",
            },
          });
        }
        await prisma.entry.update({
          where: { id: existing.entryId },
          data: {
            apr: liab?.apr ?? undefined,
            minPayment: liab?.minPayment ?? undefined,
            dueDay: liab?.dueDay ?? undefined,
          },
        });
        await prisma.plaidAccount.update({
          where: { accountId: acct.account_id },
          data: { name: acct.name, mask: acct.mask, lastBalance: current, lastSyncedAt: new Date() },
        });
        summary.debtsUpdated++;
      } else {
        const created = await prisma.entry.create({
          data: {
            userId,
            type: "debt",
            label: acct.official_name ?? acct.name,
            amount: roundCents(Math.max(0, current)),
            frequency: "once",
            apr: liab?.apr ?? null,
            minPayment: liab?.minPayment ?? null,
            dueDay: liab?.dueDay ?? null,
            note: "Synced from bank",
          },
        });
        await prisma.plaidAccount.upsert({
          where: { accountId: acct.account_id },
          create: {
            plaidItemId: item.id,
            accountId: acct.account_id,
            name: acct.name,
            mask: acct.mask,
            type: acct.type,
            subtype: acct.subtype,
            entryId: created.id,
            lastBalance: current,
            lastSyncedAt: new Date(),
          },
          update: { entryId: created.id, lastBalance: current, lastSyncedAt: new Date() },
        });
        summary.debtsCreated++;
      }
      continue;
    }

    // Other types (investment, etc.) — just track the account, no Entry.
    await prisma.plaidAccount.upsert({
      where: { accountId: acct.account_id },
      create: {
        plaidItemId: item.id,
        accountId: acct.account_id,
        name: acct.name,
        mask: acct.mask,
        type: acct.type,
        subtype: acct.subtype,
        lastBalance: current,
        lastSyncedAt: new Date(),
      },
      update: { name: acct.name, mask: acct.mask, lastBalance: current, lastSyncedAt: new Date() },
    });
  }

  if (sawDepository) summary.depositoryBalance = roundCents(depositorySum);

  const depositoryAccountIds = new Set(
    accounts.filter((a) => a.type === "depository").map((a) => a.account_id)
  );
  if (depositoryAccountIds.size > 0) {
    try {
      let cursor = item.cursor ?? undefined;
      let hasMore = true;
      const added: Transaction[] = [];
      while (hasMore) {
        const res = await plaidClient.transactionsSync({ access_token: accessToken, cursor, count: 100 });
        added.push(...res.data.added);
        cursor = res.data.next_cursor;
        hasMore = res.data.has_more;
      }

      // Import from a month before the bank was linked: on a first sync
      // that's the last 30 days, and after a re-import reset (cursor
      // cleared) it recovers everything the original imports covered.
      const cutoff = new Date(
        Math.min(Date.now(), item.createdAt.getTime()) - TRANSACTION_LOOKBACK_DAYS * 86400_000
      );
      const txns: BankTxn[] = [];
      for (const t of added) {
        // Skip pending (amount can still change), other accounts, old history.
        if (t.pending || !depositoryAccountIds.has(t.account_id)) continue;
        // File it under the day it happened. Noon UTC keeps the calendar
        // date in any North American timezone (midnight would slip back).
        const date = new Date(`${t.authorized_date ?? t.date}T12:00:00Z`);
        if (date < cutoff) continue;
        txns.push({
          key: t.transaction_id,
          account: t.account_id,
          amount: -t.amount, // Plaid: positive = money out
          date: date > new Date() ? new Date() : date,
          label: t.merchant_name ?? t.name,
          hint: plaidHint(t),
        });
      }
      const imported = await importBankTransactions({
        userId,
        txns,
        alreadyImported: async (keys) =>
          new Set(
            (
              await prisma.plaidTransaction.findMany({
                where: { transactionId: { in: keys } },
                select: { transactionId: true },
              })
            ).map((r) => r.transactionId)
          ),
        markImported: (tx, key) =>
          tx.plaidTransaction.create({ data: { transactionId: key, plaidItemId: item.id } }),
      });
      summary.transactionsImported = imported.purchases;
      summary.incomesImported = imported.incomes;
      summary.circulationImported = imported.circulation;
      summary.transfersSkipped = imported.transfers;
      // Only advance the cursor once everything it covers is imported, so a
      // failure partway through gets retried next sync instead of skipped.
      await prisma.plaidItem.update({ where: { id: item.id }, data: { cursor, status: "active", error: null } });
    } catch {
      // Transactions can be temporarily unavailable right after linking
      // (Plaid is still preparing history) — leave the cursor as-is so the
      // next sync retries, without failing the whole sync.
    }
  }

  return summary;
}
