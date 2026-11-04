import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

const pct = z.number().int().min(0).max(100);
const schema = z
  .object({ mustHaves: pct, retirement: pct, emergency: pct, couldHaves: pct })
  .refine((p) => p.mustHaves + p.retirement + p.emergency + p.couldHaves === 100, {
    message: "The split has to add up to 100%",
  });

// Saves how each paycheque is split (Paycheck → Split your paycheck).
export async function PUT(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.errors[0]?.message ?? "Invalid split" }, { status: 400 });
  const p = parsed.data;
  const data = {
    splitMustHaves: p.mustHaves,
    splitRetirement: p.retirement,
    splitEmergency: p.emergency,
    splitCouldHaves: p.couldHaves,
  };
  await prisma.paycheckProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  return NextResponse.json(p);
}
