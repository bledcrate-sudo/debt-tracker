import { prisma } from "./prisma";
import { IMPORT_NOTE } from "./bank-import";
import { syncSimplefinConnection } from "./simplefin";
import { syncPlaidItem } from "./plaid-sync";

// "Fix imported transactions": deletes every purchase/income the bank
// importers created and re-imports them, e.g. to re-date ones imported
// before transactions were back-dated to when they happened. Debts, their
// payment history, and account settings are untouched. If the re-import
// fails (bank unreachable), nothing is lost for good: the dedupe records are
// cleared and the providers reset, so the next successful sync brings the
// transactions back.
export async function reimportBankTransactions(userId: string, opts: { fetchImpl?: typeof fetch } = {}) {
  const [removed] = await prisma.$transaction([
    prisma.entry.deleteMany({
      where: { userId, note: IMPORT_NOTE, type: { in: ["purchase", "income"] } },
    }),
    prisma.simplefinTransaction.deleteMany({ where: { connection: { userId } } }),
    prisma.plaidTransaction.deleteMany({ where: { plaidItem: { userId } } }),
    // No previous sync -> the next one reads from a month before each
    // connection was made (see the start/cutoff logic in each importer).
    prisma.simplefinConnection.updateMany({ where: { userId }, data: { lastSyncedAt: null } }),
    prisma.plaidItem.updateMany({ where: { userId }, data: { cursor: null } }),
  ]);

  const result = { removed: removed.count, purchases: 0, incomes: 0, transfers: 0, errors: [] as string[] };
  const conns = await prisma.simplefinConnection.findMany({ where: { userId }, select: { id: true } });
  const items = await prisma.plaidItem.findMany({ where: { userId }, select: { id: true } });
  for (const c of conns) {
    try {
      const r = await syncSimplefinConnection(c.id, userId, { force: true, fetchImpl: opts.fetchImpl });
      result.purchases += r.transactionsImported;
      result.incomes += r.incomesImported;
      result.transfers += r.transfersSkipped;
    } catch (e: any) {
      result.errors.push(`SimpleFIN: ${e?.message ?? "sync failed"}`);
    }
  }
  for (const i of items) {
    try {
      const r = await syncPlaidItem(i.id, userId);
      result.purchases += r.transactionsImported;
      result.incomes += r.incomesImported;
      result.transfers += r.transfersSkipped;
    } catch (e: any) {
      result.errors.push(`Plaid: ${e?.response?.data?.error_message ?? e?.message ?? "sync failed"}`);
    }
  }
  return result;
}
