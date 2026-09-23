import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUserId } from "@/lib/session";
import { deleteAllEntries } from "@/lib/delete-data";

// The client must send the word the user typed, so a stray request (or a
// double tap) can't wipe the profile.
const schema = z.object({ confirm: z.literal("DELETE") });

export async function DELETE(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Type DELETE to confirm' }, { status: 400 });
  return NextResponse.json(await deleteAllEntries(userId));
}
