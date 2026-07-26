import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string; paymentId: string } }
) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const payment = await prisma.debtPayment.findUnique({ where: { id: params.paymentId } });
  if (!payment || payment.entryId !== params.id)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const entry = await prisma.entry.findUnique({ where: { id: params.id } });
  if (!entry || entry.userId !== userId)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.debtPayment.delete({ where: { id: params.paymentId } });
  return NextResponse.json({ ok: true });
}
