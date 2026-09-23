import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/session";
import { reimportBankTransactions } from "@/lib/bank-reimport";

// Settings -> Bank -> "Fix imported transactions". See lib/bank-reimport.ts.
export async function POST() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await reimportBankTransactions(userId));
}
