import { NextResponse } from "next/server";
import { plaidClient, PLAID_PRODUCTS, PLAID_COUNTRY_CODES } from "@/lib/plaid";
import { currentUserId } from "@/lib/session";

// Creates a fresh Link token for the "connect a bank" button. No item_id is
// passed, so every call starts a new Item — this is how a user links more
// than one bank (or a second account at the same bank): just run Link again.
export async function POST() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const res = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: "Debt Tracker",
      products: PLAID_PRODUCTS,
      country_codes: PLAID_COUNTRY_CODES,
      language: "en",
    });
    return NextResponse.json({ linkToken: res.data.link_token });
  } catch (e: any) {
    const message = e?.response?.data?.error_message ?? e?.message ?? "Failed to create link token";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
