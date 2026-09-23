import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { prisma } from "./prisma";
import { normalizeEmail } from "./email";

const env = process.env.PLAID_ENV ?? "sandbox";
const basePath =
  env === "production"
    ? PlaidEnvironments.production
    : env === "development"
    ? PlaidEnvironments.development
    : PlaidEnvironments.sandbox;

const globalForPlaid = globalThis as unknown as { plaidClient?: PlaidApi };

export const plaidClient =
  globalForPlaid.plaidClient ??
  new PlaidApi(
    new Configuration({
      basePath,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
          "PLAID-SECRET": process.env.PLAID_SECRET,
        },
      },
    })
  );
if (process.env.NODE_ENV !== "production") globalForPlaid.plaidClient = plaidClient;

const list = <T>(raw: string): T[] =>
  raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean) as T[];

// Required products limit Link to banks that support *every* one of them,
// so keep this minimal. Liabilities (card APR / minimum payment / due date)
// only covers some Canadian banks, so it's optional by default: any bank
// with transactions can link, and card details come through where offered.
export const PLAID_PRODUCTS = list<Products>(process.env.PLAID_PRODUCTS ?? "transactions");

// Plaid rejects a product listed as both required and optional.
export const PLAID_OPTIONAL_PRODUCTS = list<Products>(
  process.env.PLAID_OPTIONAL_PRODUCTS ?? "liabilities"
).filter((p) => !PLAID_PRODUCTS.includes(p));

export const PLAID_COUNTRY_CODES = list<CountryCode>(process.env.PLAID_COUNTRY_CODES ?? "CA");

// Registration is open, so on a public deploy anyone could sign up and link
// their own banks through this Plaid account — and on the Trial plan every
// Item counts permanently against the 10-Item cap, even once removed. Live
// mode therefore only allows emails listed in PLAID_ALLOWED_EMAILS; Sandbox
// stays open unless a list is set.
const ALLOWED_EMAILS = list<string>(process.env.PLAID_ALLOWED_EMAILS ?? "").map(normalizeEmail);

export async function plaidAccessError(userId: string): Promise<string | null> {
  if (ALLOWED_EMAILS.length === 0) {
    return env === "production"
      ? "Bank linking is locked: set PLAID_ALLOWED_EMAILS to your login email in your deployment settings"
      : null;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user && ALLOWED_EMAILS.includes(normalizeEmail(user.email))
    ? null
    : "Bank linking isn't enabled for this account";
}
