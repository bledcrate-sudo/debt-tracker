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

// `addSaved` is a delta (e.g. logging "+ $50 saved"); `savedAmount` sets the
// total outright (editing a typo). Sending both isn't meaningful — addSaved
// wins if it is.
const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  targetAmount: z.number().finite().positive().max(100_000_000).optional(),
  targetDate: dateSchema.optional().nullable(),
  savedAmount: z.number().finite().min(0).max(100_000_000).optional(),
  addSaved: z.number().finite().optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const goal = await prisma.savingsGoal.findUnique({ where: { id: params.id } });
  if (!goal || goal.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = patchSchema.parse(await req.json());
    const savedAmount =
      data.addSaved !== undefined
        ? roundCents(Math.max(0, goal.savedAmount + data.addSaved))
        : data.savedAmount !== undefined
        ? roundCents(data.savedAmount)
        : undefined;
    const updated = await prisma.savingsGoal.update({
      where: { id: params.id },
      data: {
        name: data.name,
        targetAmount: data.targetAmount !== undefined ? roundCents(data.targetAmount) : undefined,
        targetDate: data.targetDate !== undefined ? (data.targetDate ? new Date(data.targetDate) : null) : undefined,
        savedAmount,
      },
    });
    return NextResponse.json(updated);
  } catch (e: any) {
    const message = e instanceof z.ZodError ? e.errors[0]?.message ?? "Invalid goal" : "Failed to save goal";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const goal = await prisma.savingsGoal.findUnique({ where: { id: params.id } });
  if (!goal || goal.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.savingsGoal.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
