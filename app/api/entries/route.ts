import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { roundCents } from "@/lib/money";

const createSchema = z.object({
  type: z.enum(["income", "expense", "purchase", "debt"]),
  label: z.string().min(1).max(120),
  amount: z.number().finite(),
  frequency: z.enum(["once", "monthly"]).default("once"),
  apr: z.number().min(0).max(200).optional().nullable(),
  minPayment: z.number().min(0).optional().nullable(),
  dueDay: z.number().int().min(1).max(31).optional().nullable(),
  // Purchases and one-off bills: where the money came from, and which debt
  // if it was put on a card.
  source: z.enum(["balance", "off", "debt"]).default("balance"),
  debtEntryId: z.string().optional().nullable(),
  note: z.string().max(500).optional().nullable(),
});

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entries = await prisma.entry.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      payments: true,
      debtPayments: true,
      // Which bank/account an imported entry came from.
      bankTransactions: { select: { institution: true, account: true }, take: 1 },
    },
  });
  return NextResponse.json(
    entries.map(({ bankTransactions, ...e }) => ({ ...e, source: bankTransactions[0] ?? null }))
  );
}

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const data = createSchema.parse(await req.json());
    const amount = roundCents(Math.abs(data.amount));
    // Purchases are always settled at creation; one-off bills are too (only
    // monthly bills track paid/unpaid per month), so both need a source.
    const tracksSource = data.type === "purchase" || (data.type === "expense" && data.frequency === "once");

    let debt = null;
    if (tracksSource && data.source === "debt") {
      if (!data.debtEntryId)
        return NextResponse.json({ error: "Pick a debt to charge" }, { status: 400 });
      debt = await prisma.entry.findUnique({ where: { id: data.debtEntryId } });
      if (!debt || debt.userId !== userId || debt.type !== "debt")
        return NextResponse.json({ error: "Debt not found" }, { status: 404 });
    }

    const entry = await prisma.$transaction(async (tx) => {
      const created = await tx.entry.create({
        data: {
          type: data.type,
          label: data.label,
          amount,
          frequency: data.frequency,
          apr: data.type === "debt" ? data.apr ?? null : null,
          minPayment: data.type === "debt" ? data.minPayment ?? null : null,
          dueDay: data.type === "debt" ? data.dueDay ?? null : null,
          sourceKind: tracksSource ? data.source : null,
          debtEntryId: debt?.id ?? null,
          note: data.note ?? null,
          userId,
        },
      });

      if (!debt) return created;

      const charge = await tx.debtPayment.create({
        data: {
          entryId: debt.id,
          amount,
          kind: "charge",
          fromBalance: false,
          note: data.label,
        },
      });
      return tx.entry.update({
        where: { id: created.id },
        data: { chargeId: charge.id },
      });
    });

    return NextResponse.json({ ...entry, payments: [], debtPayments: [] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}
