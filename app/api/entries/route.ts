import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const createSchema = z.object({
  type: z.enum(["income", "expense", "purchase", "debt"]),
  label: z.string().min(1).max(120),
  amount: z.number().finite(),
  frequency: z.enum(["once", "monthly"]).default("once"),
  apr: z.number().min(0).max(200).optional().nullable(),
  minPayment: z.number().min(0).optional().nullable(),
  dueDay: z.number().int().min(1).max(31).optional().nullable(),
  // Purchases: where the money came from, and which debt if it was a card.
  source: z.enum(["balance", "off", "debt"]).default("balance"),
  debtEntryId: z.string().optional().nullable(),
  note: z.string().max(500).optional().nullable(),
});

async function uid() {
  const session = await getServerSession(authOptions);
  return (session?.user as any)?.id as string | undefined;
}

export async function GET() {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entries = await prisma.entry.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { payments: true, debtPayments: true },
  });
  return NextResponse.json(entries);
}

export async function POST(req: Request) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const data = createSchema.parse(await req.json());
    const amount = Math.abs(data.amount);
    const isPurchase = data.type === "purchase";

    // A purchase put on a card raises a charge against that debt instead of
    // coming out of the balance.
    let debt = null;
    if (isPurchase && data.source === "debt") {
      if (!data.debtEntryId)
        return NextResponse.json({ error: "Pick a debt to charge" }, { status: 400 });
      debt = await prisma.entry.findUnique({ where: { id: data.debtEntryId } });
      if (!debt || debt.userId !== userId || debt.type !== "debt")
        return NextResponse.json({ error: "Debt not found" }, { status: 404 });
    }

    const entry = await prisma.entry.create({
      data: {
        type: data.type,
        label: data.label,
        amount,
        frequency: data.frequency,
        apr: data.type === "debt" ? data.apr ?? null : null,
        minPayment: data.type === "debt" ? data.minPayment ?? null : null,
        dueDay: data.type === "debt" ? data.dueDay ?? null : null,
        sourceKind: isPurchase ? data.source : null,
        debtEntryId: debt?.id ?? null,
        note: data.note ?? null,
        user: { connect: { id: userId } },
      },
    });

    if (debt) {
      const charge = await prisma.debtPayment.create({
        data: {
          entryId: debt.id,
          amount,
          kind: "charge",
          fromBalance: false,
          note: data.label,
        },
      });
      const linked = await prisma.entry.update({
        where: { id: entry.id },
        data: { chargeId: charge.id },
      });
      return NextResponse.json({ ...linked, payments: [], debtPayments: [] });
    }

    return NextResponse.json({ ...entry, payments: [], debtPayments: [] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}
