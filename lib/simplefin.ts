import { prisma } from "./prisma";
import { encryptToken, decryptToken } from "./plaid-crypto";
import { roundCents } from "./money";

// SimpleFIN protocol v1 (https://www.simplefin.org/protocol.html): the user
// gets a one-time Setup Token from SimpleFIN Bridge, we POST to the claim URL
// it encodes to get a long-lived Access URL (with Basic Auth credentials
// embedded), then GET <access url>/accounts for balances and transactions.

export type SimplefinTransactionData = {
  id: string;
  posted: number;
  amount: string;
  description: string;
  payee?: string;
  pending?: boolean;
};

export type SimplefinAccountData = {
  org: { name?: string; domain?: string };
  id: string;
  name: string;
  currency: string;
  balance: string;
  "available-balance"?: string;
  "balance-date": number;
  transactions?: SimplefinTransactionData[];
};

export type AccountSet = { errors: string[]; accounts: SimplefinAccountData[] };
export type AccountKind = "cash" | "debt" | "ignore";

type Fetch = typeof fetch;

export class SimplefinError extends Error {}

// A network failure surfaces as a bare "fetch failed" — say what it means.
async function request(fetchImpl: Fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw new SimplefinError("Couldn't reach SimpleFIN — check your connection and try again");
  }
}

// First sync pulls a month of history (matching Plaid); later syncs re-read
// the week before the last sync so late-posting transactions aren't missed —
// the per-transaction dedupe makes the overlap harmless.
const FIRST_SYNC_DAYS = 30;
const RESYNC_OVERLAP_DAYS = 7;
// Bridge caps requests at 24/day per connection and refreshes bank data
// about once a day, so syncing more often than this only burns quota.
export const SYNC_COOLDOWN_MS = 10 * 60 * 1000;

export function decodeSetupToken(token: string): string {
  let url: URL;
  try {
    url = new URL(Buffer.from(token.trim(), "base64").toString("utf8").trim());
  } catch {
    throw new SimplefinError("That doesn't look like a SimpleFIN setup token — copy it again from SimpleFIN Bridge");
  }
  if (url.protocol !== "https:") throw new SimplefinError("SimpleFIN setup token must point to an https:// address");
  return url.toString();
}

export async function claimAccessUrl(setupToken: string, fetchImpl: Fetch = fetch): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);
  const res = await request(fetchImpl, claimUrl, { method: "POST", headers: { "content-length": "0" } });
  if (res.status === 403)
    throw new SimplefinError(
      "This setup token was already used or isn't valid. If you didn't use it yourself, it may be compromised — disable it on SimpleFIN Bridge and create a new one."
    );
  if (!res.ok) throw new SimplefinError(`SimpleFIN claim failed (HTTP ${res.status})`);
  const accessUrl = (await res.text()).trim();
  const parsed = new URL(accessUrl);
  if (parsed.protocol !== "https:" || !parsed.username)
    throw new SimplefinError("SimpleFIN returned an unexpected access URL");
  return accessUrl;
}

// fetch() refuses URLs with embedded credentials, so move them into an
// Authorization header.
export async function fetchAccountSet(
  accessUrl: string,
  startDate: Date,
  fetchImpl: Fetch = fetch
): Promise<AccountSet> {
  const url = new URL(accessUrl);
  const auth = Buffer.from(
    `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
  ).toString("base64");
  url.username = "";
  url.password = "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/accounts`;
  url.searchParams.set("start-date", String(Math.floor(startDate.getTime() / 1000)));

  const res = await request(fetchImpl, url.toString(), { headers: { authorization: `Basic ${auth}` } });
  if (res.status === 403)
    throw new SimplefinError("SimpleFIN access was revoked or is invalid — reconnect with a new setup token");
  if (res.status === 402) throw new SimplefinError("SimpleFIN Bridge subscription needs payment");
  if (!res.ok) throw new SimplefinError(`SimpleFIN request failed (HTTP ${res.status})`);
  const body = (await res.json()) as AccountSet;
  return { errors: body.errors ?? [], accounts: body.accounts ?? [] };
}

// The spec requires sanitizing server-supplied error strings before showing
// them: keep printable text only and cap the length.
export function sanitizeMessage(msg: unknown): string {
  return String(msg)
    .replace(/<[^>]*>/g, "")
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "")
    .trim()
    .slice(0, 300);
}

const DEBT_NAME = /credit|visa|master ?card|amex|american express|loan|line of credit|\bloc\b|mortgage/i;

// SimpleFIN has no account type field. Cards and loans usually report a
// negative balance (money owed) or have a telling name; the user can
// override the guess in the Bank settings either way.
export function guessKind(name: string, balance: number): AccountKind {
  return balance < 0 || DEBT_NAME.test(name) ? "debt" : "cash";
}

// Owed amount for a debt account, whichever sign the institution uses.
export const owedFrom = (balance: number) => roundCents(Math.abs(balance));

export type SimplefinSyncSummary = {
  accountsSeen: number;
  debtsCreated: number;
  debtsUpdated: number;
  transactionsImported: number;
  cashBalance: number | null;
  warnings: string[];
  skipped?: "cooldown";
};

export async function createConnection(userId: string, setupToken: string, fetchImpl: Fetch = fetch) {
  const accessUrl = await claimAccessUrl(setupToken, fetchImpl);
  return prisma.simplefinConnection.create({
    data: { userId, accessUrl: encryptToken(accessUrl) },
  });
}

export async function syncSimplefinConnection(
  connectionId: string,
  userId: string,
  opts: { force?: boolean; fetchImpl?: Fetch } = {}
): Promise<SimplefinSyncSummary> {
  const conn = await prisma.simplefinConnection.findUnique({
    where: { id: connectionId },
    include: { accounts: true },
  });
  if (!conn || conn.userId !== userId) throw new SimplefinError("Connection not found");

  const summary: SimplefinSyncSummary = {
    accountsSeen: 0,
    debtsCreated: 0,
    debtsUpdated: 0,
    transactionsImported: 0,
    cashBalance: null,
    warnings: [],
  };
  if (!opts.force && conn.lastSyncedAt && Date.now() - conn.lastSyncedAt.getTime() < SYNC_COOLDOWN_MS) {
    summary.skipped = "cooldown";
    return summary;
  }

  const start = conn.lastSyncedAt
    ? new Date(conn.lastSyncedAt.getTime() - RESYNC_OVERLAP_DAYS * 86400_000)
    : new Date(Date.now() - FIRST_SYNC_DAYS * 86400_000);
  const set = await fetchAccountSet(decryptToken(conn.accessUrl), start, opts.fetchImpl);
  summary.warnings = set.errors.map(sanitizeMessage).filter(Boolean);
  summary.accountsSeen = set.accounts.length;

  let cashSum = 0;
  let sawCash = false;
  const now = new Date();

  for (const acct of set.accounts) {
    const balance = parseFloat(acct.balance);
    if (!Number.isFinite(balance)) continue;
    const existing = conn.accounts.find((a) => a.accountId === acct.id);
    const kind = (existing?.kind ?? guessKind(acct.name, balance)) as AccountKind;
    const orgName = acct.org?.name ?? acct.org?.domain ?? null;

    const row =
      existing ??
      (await prisma.simplefinAccount.create({
        data: {
          connectionId: conn.id,
          accountId: acct.id,
          orgName,
          name: acct.name,
          currency: acct.currency,
          kind,
        },
      }));

    if (kind === "ignore") {
      await prisma.simplefinAccount.update({
        where: { id: row.id },
        data: { name: acct.name, orgName, lastBalance: balance, lastSyncedAt: now },
      });
      continue;
    }

    if (kind === "debt") {
      const owed = owedFrom(balance);
      let entryId = row.entryId;
      if (entryId) {
        const delta = roundCents(owed - (row.lastBalance ?? owed));
        if (Math.abs(delta) >= 0.01) {
          await prisma.debtPayment.create({
            data: {
              entryId,
              amount: Math.abs(delta),
              kind: delta > 0 ? "charge" : "payment",
              fromBalance: false,
              note: "Synced from bank",
            },
          });
        }
        summary.debtsUpdated++;
      } else {
        const created = await prisma.entry.create({
          data: {
            userId,
            type: "debt",
            label: orgName ? `${orgName} ${acct.name}` : acct.name,
            amount: owed,
            frequency: "once",
            note: "Synced from bank",
          },
        });
        entryId = created.id;
        summary.debtsCreated++;
      }
      await prisma.simplefinAccount.update({
        where: { id: row.id },
        data: { name: acct.name, orgName, entryId, lastBalance: owed, lastSyncedAt: now },
      });
      continue;
    }

    // Cash (chequing/savings): count the balance and import spending.
    sawCash = true;
    const available = parseFloat(acct["available-balance"] ?? "");
    cashSum += Number.isFinite(available) ? available : balance;
    await prisma.simplefinAccount.update({
      where: { id: row.id },
      data: { name: acct.name, orgName, lastBalance: balance, lastSyncedAt: now },
    });

    for (const t of acct.transactions ?? []) {
      const amount = parseFloat(t.amount);
      // Positive = deposit; only money out becomes a purchase, and pending
      // amounts can still change, so wait for them to post.
      if (t.pending || !Number.isFinite(amount) || amount >= 0) continue;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.simplefinTransaction.create({
            data: { key: `${row.id}:${t.id}`, connectionId: conn.id },
          });
          await tx.entry.create({
            data: {
              userId,
              type: "purchase",
              label: (t.payee || t.description || "Bank transaction").slice(0, 120),
              amount: roundCents(-amount),
              frequency: "once",
              sourceKind: "balance",
              note: "Synced from bank",
            },
          });
        });
        summary.transactionsImported++;
      } catch (e: any) {
        if (e?.code !== "P2002") throw e; // already imported
      }
    }
  }

  if (sawCash) summary.cashBalance = roundCents(cashSum);
  await prisma.simplefinConnection.update({
    where: { id: conn.id },
    data: {
      lastSyncedAt: now,
      status: "active",
      error: summary.warnings.length ? summary.warnings.join(" · ").slice(0, 500) : null,
    },
  });
  return summary;
}
