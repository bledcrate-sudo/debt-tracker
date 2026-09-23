import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/session";
import { getBankBalance } from "@/lib/bank-balance";

// Live balance of connected chequing/savings accounts (null if none).
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await getBankBalance(userId));
}
