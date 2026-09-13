import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

// ISO 4217 codes are three uppercase letters; validate the shape and then
// confirm Intl actually knows how to format it before storing.
const schema = z.object({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .refine((code) => {
      try {
        new Intl.NumberFormat("en", { style: "currency", currency: code }).format(1);
        return true;
      } catch {
        return false;
      }
    }, "Unknown currency code"),
});

export async function PATCH(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { currency } = schema.parse(await req.json());
    const user = await prisma.user.update({
      where: { id: userId },
      data: { currency },
      select: { currency: true },
    });
    return NextResponse.json(user);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}
