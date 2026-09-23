import { NextResponse } from "next/server";
import { z } from "zod";
import { plaidClient } from "@/lib/plaid";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { encryptToken } from "@/lib/plaid-crypto";
import { syncPlaidItem } from "@/lib/plaid-sync";

// Institution name/id come straight from Link's onSuccess metadata — no need
// for an extra round trip to look them up.
const schema = z.object({
  publicToken: z.string().min(1),
  institutionId: z.string().optional().nullable(),
  institutionName: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { publicToken, institutionId, institutionName } = schema.parse(await req.json());

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    const { access_token: accessToken, item_id: itemId } = exchange.data;

    const item = await prisma.plaidItem.create({
      data: {
        userId,
        itemId,
        accessToken: encryptToken(accessToken),
        institutionId: institutionId ?? null,
        institutionName: institutionName ?? null,
      },
    });

    const summary = await syncPlaidItem(item.id, userId);
    return NextResponse.json({ itemId: item.id, ...summary });
  } catch (e: any) {
    const message = e?.response?.data?.error_message ?? e?.message ?? "Failed to link bank";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
