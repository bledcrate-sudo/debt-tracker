import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const createSchema = z.object({
  type: z.enum(["income", "expense", "debt"]),
  label: z.string().min(1).max(120),
  amount: z.number().finite(),
  frequency: z.enum(["once", "monthly"]).default("once"),
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
  });
  return NextResponse.json(entries);
}

export async function POST(req: Request) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const data = createSchema.parse(await req.json());
    const entry = await prisma.entry.create({
      data: {
        type: data.type,
        label: data.label,
        amount: Math.abs(data.amount),
        frequency: data.frequency,
        note: data.note ?? null,
        user: { connect: { id: userId } },
      },
    });
    return NextResponse.json(entry);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}
