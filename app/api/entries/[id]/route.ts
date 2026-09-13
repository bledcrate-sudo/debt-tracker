import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { roundCents } from "@/lib/money";

// Editable fields only: label/amount/note for any entry, plus apr/minPayment/
// dueDay for debts. Frequency, type, and purchase source are excluded —
// changing those after the fact would desync the month-by-month payment
// history and card charges already recorded against the entry.
const patchSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  amount: z.number().finite().positive().optional(),
  note: z.string().max(500).optional().nullable(),
  apr: z.number().min(0).max(200).optional().nullable(),
  minPayment: z.number().min(0).optional().nullable(),
  dueDay: z.number().int().min(1).max(31).optional().nullable(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entry = await prisma.entry.findUnique({ where: { id: params.id } });
  if (!entry || entry.userId !== userId)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = patchSchema.parse(await req.json());
    const isDebt = entry.type === "debt";
    const updated = await prisma.entry.update({
      where: { id: params.id },
      data: {
        label: data.label,
        amount: data.amount !== undefined ? roundCents(Math.abs(data.amount)) : undefined,
        note: data.note !== undefined ? data.note : undefined,
        apr: isDebt && data.apr !== undefined ? data.apr : undefined,
        minPayment: isDebt && data.minPayment !== undefined ? data.minPayment : undefined,
        dueDay: isDebt && data.dueDay !== undefined ? data.dueDay : undefined,
      },
      include: { payments: true, debtPayments: true },
    });
    return NextResponse.json(updated);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entry = await prisma.entry.findUnique({ where: { id: params.id } });
  if (!entry || entry.userId !== userId)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A purchase or one-off bill charged to a card owns the matching debt
  // charge; deleting it has to take that charge with it, or the debt keeps
  // the phantom balance.
  await prisma.$transaction(async (tx) => {
    if (entry.chargeId) await tx.debtPayment.deleteMany({ where: { id: entry.chargeId } });
    await tx.entry.delete({ where: { id: params.id } });
  });
  return NextResponse.json({ ok: true });
}
