import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const monthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

const postSchema = monthSchema.extend({
  fromBalance: z.boolean().default(true),
});

async function ownedEntry(id: string, userId: string) {
  const entry = await prisma.entry.findUnique({ where: { id } });
  if (!entry || entry.userId !== userId) return null;
  return entry;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entry = await ownedEntry(params.id, userId);
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { month, fromBalance } = postSchema.parse(await req.json());
    const payment = await prisma.payment.upsert({
      where: { entryId_month: { entryId: entry.id, month } },
      update: { fromBalance },
      create: { entryId: entry.id, month, fromBalance },
    });
    return NextResponse.json(payment);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entry = await ownedEntry(params.id, userId);
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { month } = monthSchema.parse(await req.json());
    await prisma.payment.deleteMany({ where: { entryId: entry.id, month } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}
