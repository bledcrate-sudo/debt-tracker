import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

const monthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

const postSchema = monthSchema.extend({
  // "balance"  — money leaves the tracked balance
  // "off"      — paid with untracked money, balance unaffected
  // "debt"     — put on a credit card / loan, which raises that debt instead
  source: z.enum(["balance", "off", "debt"]).default("balance"),
  debtEntryId: z.string().optional().nullable(),
});

async function ownedEntry(id: string, userId: string) {
  const entry = await prisma.entry.findUnique({ where: { id } });
  if (!entry || entry.userId !== userId) return null;
  return entry;
}

// A bill charged to a card leaves a matching charge on that debt. Clearing the
// paid flag has to take the charge with it, or the debt keeps growing.
async function dropCharge(tx: Prisma.TransactionClient, chargeId: string | null | undefined) {
  if (!chargeId) return;
  await tx.debtPayment.deleteMany({ where: { id: chargeId } });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entry = await ownedEntry(params.id, userId);
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { month, source, debtEntryId } = postSchema.parse(await req.json());

    let debt = null;
    if (source === "debt") {
      if (!debtEntryId)
        return NextResponse.json({ error: "Pick a debt to charge" }, { status: 400 });
      debt = await prisma.entry.findUnique({ where: { id: debtEntryId } });
      if (!debt || debt.userId !== userId || debt.type !== "debt")
        return NextResponse.json({ error: "Debt not found" }, { status: 404 });
    }

    const payment = await prisma.$transaction(async (tx) => {
      // Re-paying the same month must not leave the previous charge behind.
      const existing = await tx.payment.findUnique({
        where: { entryId_month: { entryId: entry.id, month } },
      });
      await dropCharge(tx, existing?.chargeId);

      let chargeId: string | null = null;
      if (debt) {
        const charge = await tx.debtPayment.create({
          data: {
            entryId: debt.id,
            amount: entry.amount,
            kind: "charge",
            fromBalance: false,
            note: `${entry.label} (${month})`,
          },
        });
        chargeId = charge.id;
      }

      return tx.payment.upsert({
        where: { entryId_month: { entryId: entry.id, month } },
        update: { fromBalance: source === "balance", debtEntryId: debt?.id ?? null, chargeId },
        create: {
          entryId: entry.id,
          month,
          fromBalance: source === "balance",
          debtEntryId: debt?.id ?? null,
          chargeId,
        },
      });
    });
    return NextResponse.json(payment);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entry = await ownedEntry(params.id, userId);
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { month } = monthSchema.parse(await req.json());
    await prisma.$transaction(async (tx) => {
      const existing = await tx.payment.findUnique({
        where: { entryId_month: { entryId: entry.id, month } },
      });
      await dropCharge(tx, existing?.chargeId);
      await tx.payment.deleteMany({ where: { entryId: entry.id, month } });
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}
