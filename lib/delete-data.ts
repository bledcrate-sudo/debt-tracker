import { prisma } from "./prisma";

// Settings -> Bank -> "Delete all data": every entry on the profile (with its
// payments and debt payments, which cascade) and the transactions feed, plus
// the importers' "already imported" records and sync positions — so "Fix
// imported transactions" (or the next sync) brings the bank data back, debts
// included. Bank connections, budget essentials and settings are kept.
export async function deleteAllEntries(userId: string) {
  const [, entries] = await prisma.$transaction([
    prisma.bankTransaction.deleteMany({ where: { userId } }),
    prisma.entry.deleteMany({ where: { userId } }),
    prisma.simplefinTransaction.deleteMany({ where: { connection: { userId } } }),
    prisma.plaidTransaction.deleteMany({ where: { plaidItem: { userId } } }),
    prisma.simplefinConnection.updateMany({ where: { userId }, data: { lastSyncedAt: null } }),
    prisma.plaidItem.updateMany({ where: { userId }, data: { cursor: null } }),
  ]);
  return { deleted: entries.count };
}
