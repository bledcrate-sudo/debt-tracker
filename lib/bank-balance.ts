import { prisma } from "./prisma";
import { roundCents } from "./money";

export type BankBalance = { balance: number; asOf: string | null; accounts: number };

// The real money in the user's connected chequing/savings accounts — what
// the dashboard shows as Balance whenever at least one is connected, instead
// of a figure computed from entries. Cards and loans aren't included (they're
// debts). Uses each account's balance as of its last sync; null when no
// cash account is connected.
export async function getBankBalance(userId: string): Promise<BankBalance | null> {
  const [plaid, simplefin] = await Promise.all([
    prisma.plaidAccount.findMany({
      where: { plaidItem: { userId }, type: "depository", lastBalance: { not: null } },
      select: { lastBalance: true, lastSyncedAt: true },
    }),
    prisma.simplefinAccount.findMany({
      where: { connection: { userId }, kind: "cash", lastBalance: { not: null } },
      select: { lastBalance: true, lastSyncedAt: true },
    }),
  ]);
  const accounts = [...plaid, ...simplefin];
  if (accounts.length === 0) return null;
  // The oldest sync is what the total is only as fresh as.
  const synced = accounts.map((a) => a.lastSyncedAt?.getTime()).filter((t): t is number => t != null);
  return {
    balance: roundCents(accounts.reduce((s, a) => s + (a.lastBalance ?? 0), 0)),
    asOf: synced.length ? new Date(Math.min(...synced)).toISOString() : null,
    accounts: accounts.length,
  };
}
