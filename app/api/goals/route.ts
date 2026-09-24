import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { roundCents } from "@/lib/money";

const dateSchema = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  targetAmount: z.number().finite().positive().max(100_000_000),
  targetDate: dateSchema.optional().nullable(),
  savedAmount: z.number().finite().min(0).max(100_000_000).optional(),
});

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const goals = await prisma.savingsGoal.findMany({
    where: { userId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(goals);
}

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const data = createSchema.parse(await req.json());
    const count = await prisma.savingsGoal.count({ where: { userId } });
    const goal = await prisma.savingsGoal.create({
      data: {
        userId,
        name: data.name,
        targetAmount: roundCents(data.targetAmount),
        savedAmount: roundCents(data.savedAmount ?? 0),
        targetDate: data.targetDate ? new Date(data.targetDate) : null,
        sortOrder: count,
      },
    });
    return NextResponse.json(goal);
  } catch (e: any) {
    const message = e instanceof z.ZodError ? e.errors[0]?.message ?? "Invalid goal" : "Failed to add goal";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
