import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { CATEGORIES } from "@/lib/categorize";

const schema = z.object({ category: z.enum(CATEGORIES).nullable() });

// Overrides the guessed category on one transaction in the merged feed.
// A later re-import ("Fix imported transactions") recomputes it from
// scratch, same as it resets everything else the importers created.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "Invalid category" }, { status: 400 });

  const row = await prisma.bankTransaction.findUnique({ where: { id: params.id } });
  if (!row || row.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updated = await prisma.bankTransaction.update({
    where: { id: params.id },
    data: { category: body.data.category },
  });
  return NextResponse.json({ id: updated.id, category: updated.category });
}
