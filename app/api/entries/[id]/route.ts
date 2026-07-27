import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entry = await prisma.entry.findUnique({ where: { id: params.id } });
  if (!entry || entry.userId !== userId)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A purchase charged to a card owns the matching debt charge; deleting the
  // purchase has to take it with it, or the debt keeps the phantom balance.
  if (entry.chargeId) await prisma.debtPayment.deleteMany({ where: { id: entry.chargeId } });
  await prisma.entry.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
