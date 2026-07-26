import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const createSchema = z.object({
  amount: z.number().finite().positive(),
  kind: z.enum(["payment", "charge"]).default("payment"),
  note: z.string().max(300).optional().nullable(),
});

async function ownedEntry(id: string, userId: string) {
  const entry = await prisma.entry.findUnique({ where: { id } });
  if (!entry || entry.userId !== userId || entry.type !== "debt") return null;
  return entry;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entry = await ownedEntry(params.id, userId);
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = createSchema.parse(await req.json());
    const payment = await prisma.debtPayment.create({
      data: { entryId: entry.id, amount: data.amount, kind: data.kind, note: data.note ?? null },
    });
    return NextResponse.json(payment);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}
