import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncPlaidItem } from "@/lib/plaid-sync";
import { syncSimplefinConnection } from "@/lib/simplefin";

export const maxDuration = 300;

// Refreshes every connected bank for every user once a day, so Balance and
// the transactions feed are current without anyone opening the app first —
// see vercel.json for the schedule. Vercel signs cron requests with
// CRON_SECRET as a bearer token when that env var is set; require it in
// production so the endpoint can't be triggered by anyone else.
export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") {
    const auth = req.headers.get("authorization");
    if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [items, conns] = await Promise.all([
    prisma.plaidItem.findMany({ select: { id: true, userId: true } }),
    prisma.simplefinConnection.findMany({ select: { id: true, userId: true } }),
  ]);

  let plaidOk = 0;
  let plaidFailed = 0;
  for (const item of items) {
    try {
      await syncPlaidItem(item.id, item.userId);
      await prisma.plaidItem.update({ where: { id: item.id }, data: { status: "active", error: null } });
      plaidOk++;
    } catch (e: any) {
      plaidFailed++;
      const message = e?.response?.data?.error_message ?? e?.message ?? "Sync failed";
      await prisma.plaidItem.update({ where: { id: item.id }, data: { status: "error", error: message } });
    }
  }

  let simplefinOk = 0;
  let simplefinFailed = 0;
  for (const conn of conns) {
    try {
      // Not forced: SimpleFIN's own cooldown (~once a day) still applies, so
      // a daily cron just keeps every connection in sync without wasting
      // its limited request quota.
      await syncSimplefinConnection(conn.id, conn.userId);
      simplefinOk++;
    } catch (e: any) {
      simplefinFailed++;
      const message = e?.message ?? "Sync failed";
      await prisma.simplefinConnection.update({ where: { id: conn.id }, data: { status: "error", error: message } });
    }
  }

  return NextResponse.json({ plaidOk, plaidFailed, simplefinOk, simplefinFailed });
}
