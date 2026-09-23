import type { Transaction } from "plaid";
import { plaidClient } from "./plaid";
import { prisma } from "./prisma";
import { decryptToken } from "./plaid-crypto";
import { roundCents } from "./money";

export type SyncSummary = {
  accountsSeen: number;
  debtsCreated: number;
  debtsUpdated: number;
  transactionsImported: number;
  // Sum of current depository (checking/savings) balances this sync saw,
  // null if the item has no depository accounts. Surfaced to the user to
  // apply manually — see the note on why this isn't written automatically.
  depositoryBalance: number | null;
};

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
//     for the caller to display, and their non-pending spend transactions
//     import as one-off purchases, deduped by Plaid's transaction_id.
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

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - TRANSACTION_LOOKBACK_DAYS);
      for (const t of added) {
        // Plaid: positive amount = money out. Skip pending (amount can still
        // change), deposits/refunds, other accounts, and old history.
        if (t.pending || t.amount <= 0 || !depositoryAccountIds.has(t.account_id)) continue;
        if (new Date(t.date) < cutoff) continue;
        try {
          // The PlaidTransaction insert is the dedupe guard: its primary key
          // is the transaction_id, so an already-imported one fails with
          // P2002 and rolls the purchase back with it.
          await prisma.$transaction(async (tx) => {
            await tx.plaidTransaction.create({
              data: { transactionId: t.transaction_id, plaidItemId: item.id },
            });
            await tx.entry.create({
              data: {
                userId,
                type: "purchase",
                label: t.merchant_name ?? t.name,
                amount: roundCents(t.amount),
                frequency: "once",
                sourceKind: "balance",
                note: "Synced from bank",
              },
            });
          });
          summary.transactionsImported++;
        } catch (e: any) {
          if (e?.code !== "P2002") throw e; // already imported — fine, skip
        }
      }
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
