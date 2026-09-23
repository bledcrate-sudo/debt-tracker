import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { roundCents } from "@/lib/money";

const itemSchema = z.object({
  label: z.string().trim().min(1).max(60),
  amount: z.number().finite().min(0).max(1_000_000),
  keywords: z.string().max(300).optional().nullable(),
});
const schema = z.object({
  // Replaces the whole list — the editor always saves every row at once.
  items: z.array(itemSchema).max(50).optional(),
  debtSharePct: z.number().int().min(0).max(100).optional(),
});

async function load(userId: string) {
  const [items, user] = await Promise.all([
    prisma.budgetItem.findMany({
      where: { userId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, label: true, amount: true, keywords: true },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { debtSharePct: true } }),
  ]);
  return { items, debtSharePct: user?.debtSharePct ?? 50 };
}

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await load(userId));
}

export async function PUT(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { items, debtSharePct } = schema.parse(await req.json());
    await prisma.$transaction([
      ...(items
        ? [
            prisma.budgetItem.deleteMany({ where: { userId } }),
            prisma.budgetItem.createMany({
              data: items.map((it, i) => ({
                userId,
                label: it.label,
                amount: roundCents(it.amount),
                keywords: it.keywords?.trim() || null,
                sortOrder: i,
              })),
            }),
          ]
        : []),
      ...(debtSharePct !== undefined
        ? [prisma.user.update({ where: { id: userId }, data: { debtSharePct } })]
        : []),
    ]);
    return NextResponse.json(await load(userId));
  } catch (e: any) {
    const message = e instanceof z.ZodError ? e.errors[0]?.message ?? "Invalid budget" : "Failed to save budget";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
