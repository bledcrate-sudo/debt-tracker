import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { roundCents } from "@/lib/money";

const schema = z.object({
  balanceAdjustment: z.number().finite(),
});

export async function PATCH(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { balanceAdjustment } = schema.parse(await req.json());
    const user = await prisma.user.update({
      where: { id: userId },
      data: { balanceAdjustment: roundCents(balanceAdjustment) },
      select: { balanceAdjustment: true },
    });
    return NextResponse.json(user);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}
