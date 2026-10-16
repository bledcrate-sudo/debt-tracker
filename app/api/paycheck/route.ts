import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { roundCents } from "@/lib/money";
import { PAY_PERIODS } from "@/lib/paycheck";

const money = z.number().finite().min(0).max(10_000);
const hours = z.number().finite().min(0).max(400);
const schema = z.object({
  hourlyRate: money,
  overtimeRate: money,
  regularHours: hours,
  overtimeHours: hours,
  payFrequency: z.enum(Object.keys(PAY_PERIODS) as [keyof typeof PAY_PERIODS, ...(keyof typeof PAY_PERIODS)[]]),
  ytdGross: z.number().finite().min(0).max(10_000_000).nullable(),
  otherDeductions: z.number().finite().min(0).max(100_000),
  northernDeduction: z.boolean(),
});

// The paycheck calculator's saved inputs (null until first saved).
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const profile = await prisma.paycheckProfile.findUnique({ where: { userId } });
  return NextResponse.json(profile);
}

export async function PUT(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.errors[0]?.message ?? "Invalid input" }, { status: 400 });
  const d = parsed.data;
  const data = {
    hourlyRate: roundCents(d.hourlyRate),
    overtimeRate: roundCents(d.overtimeRate),
    regularHours: d.regularHours,
    overtimeHours: d.overtimeHours,
    payFrequency: d.payFrequency,
    ytdGross: d.ytdGross === null ? null : roundCents(d.ytdGross),
    otherDeductions: roundCents(d.otherDeductions),
    northernDeduction: d.northernDeduction,
  };
  const profile = await prisma.paycheckProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  return NextResponse.json(profile);
}
