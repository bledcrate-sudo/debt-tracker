import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";

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

export const PLAID_PRODUCTS: Products[] = (process.env.PLAID_PRODUCTS ?? "transactions,liabilities")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean) as Products[];

export const PLAID_COUNTRY_CODES: CountryCode[] = (process.env.PLAID_COUNTRY_CODES ?? "US")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean) as CountryCode[];
