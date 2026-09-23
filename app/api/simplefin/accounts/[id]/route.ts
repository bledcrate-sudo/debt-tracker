import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

const schema = z.object({ kind: z.enum(["cash", "debt", "ignore"]) });

// Overrides the guessed account type. lastBalance is cleared so the next
// sync treats the new kind as a fresh start instead of computing a
// charge/payment from a balance recorded under the old kind.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const account = await prisma.simplefinAccount.findUnique({
    where: { id: params.id },
    include: { connection: { select: { userId: true } } },
  });
  if (!account || account.connection.userId !== userId)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { kind } = schema.parse(await req.json());
    if (kind === account.kind) return NextResponse.json({ kind });
    const updated = await prisma.simplefinAccount.update({
      where: { id: account.id },
      data: { kind, lastBalance: null },
      select: { kind: true },
    });
    return NextResponse.json(updated);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid" }, { status: 400 });
  }
}
