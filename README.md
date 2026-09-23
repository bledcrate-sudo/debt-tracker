# Debty

Next.js + React app for tracking income, bills, purchases, and debt payoff — with a
month-by-month ledger, an avalanche/snowball payoff planner, and an iOS build via Capacitor.

## Setup

```bash
cd debt-tracker
npm install
cp .env.example .env   # fill in a real DATABASE_URL and NEXTAUTH_SECRET
npx prisma db push
npm run dev
```

Open http://localhost:5000 — register, log in, add entries.

### Connecting a bank (Plaid)

Optional — the app works fully without it. To auto-track credit cards/loans (balance, APR,
minimum payment, due date) and import recent checking-account transactions instead of entering
them by hand:

1. Create a free developer account at [dashboard.plaid.com](https://dashboard.plaid.com/signup)
   and grab your `client_id` and Sandbox `secret` from Team Settings → Keys.
2. Fill in the `PLAID_*` variables in `.env` (see `.env.example`) — `PLAID_TOKEN_ENCRYPTION_KEY`
   is your own random key (`openssl rand -hex 32`), not something from Plaid.
3. In the app, open Settings → Bank → "Connect a bank". In Sandbox, use username `user_good` /
   password `pass_good` for any test institution.
4. Connect as many banks as you like — each one is a separate item you can sync or unlink
   independently. Credit/loan accounts sync automatically; a checking/savings balance is shown
   for you to apply manually so it doesn't clash with balance history you've already entered.

Liabilities (card APR, minimum payment, due date) is requested as an optional product, since
only some banks — especially in Canada — support it. Any bank with transactions can link; where
Liabilities isn't available, cards and loans still sync their balance and you fill in the rest.

Sandbox is free and unlimited. Moving to real accounts needs Plaid's Trial plan (also free, up to
10 linked accounts) — swap `PLAID_ENV` to `production`, use your production `secret`, and set
`PLAID_ALLOWED_EMAILS` to your login email. Live mode refuses to link banks without it: sign-up is
open, and every Item a stranger linked would count permanently against the 10-Item cap.

### Connecting a bank (SimpleFIN)

For banks Plaid doesn't cover, [SimpleFIN Bridge](https://beta-bridge.simplefin.org) (~$15/year,
US and Canada) works alongside it — no developer account needed:

1. Sign up at SimpleFIN Bridge, connect your bank there, then create a new connection to get a
   one-time **setup token**.
2. In the app: Settings → Bank → paste the token → "Connect with SimpleFIN".
3. SimpleFIN doesn't report account types, so each account starts as a guess (negative balance
   or a card/loan name → Debt, otherwise Cash). Change any account to Cash, Debt, or Ignore in
   the Bank tab.

Debt accounts sync their balance (APR, minimum payment and due date aren't provided — enter them
once). Cash accounts make up your Balance.

With any chequing/savings account connected, **Balance is the real total in those accounts**
(as of their last sync), not a figure computed from entries; past months are worked backwards
from it through the recorded flows. Without a bank connected, Balance is computed as before.

Both providers import chequing/savings and credit card transactions dated when they happened,
sorted by description (Plaid's own categories when available). Card spending shows as purchases
"On card" (not taken out of Balance, and not added to the card's debt twice — its balance sync
already counts it). Debit card purchases ("Interac purchase - …") are purchases; only
e-transfers and transfers are Circulation. Pending transactions wait until they post.

- **Income** — payroll and deposits
- **Purchases** — spending
- **Circulation** — money moving that's neither earned nor spent: e-transfers either way,
  refunds, credit card/loan payments (the spending already happened on the card, tracked as a
  debt). It moves the balance but stays out of income and spending totals.

Transfers between your own accounts — the same amount out of one and into another within 3 days —
are skipped on both sides. If you also track your pay as a manual income entry, remove it or it's
counted twice. Settings → Bank → "Fix imported transactions" deletes everything the importers
created and re-imports it with the current rules (debts are left alone) — run it once after
upgrading to fill the All transactions feed with history imported before the feed existed.
SimpleFIN refreshes about once a day and allows ~24 requests a day, so syncs within 10 minutes of
the last one are skipped. The Access URL is stored encrypted with `PLAID_TOKEN_ENCRYPTION_KEY`.

## Stack

- Next.js 14 (App Router) + React 18
- NextAuth (credentials) + bcrypt
- Prisma + PostgreSQL
- Tailwind CSS
- Vitest for unit tests (`npm test`)

## Features

- Email/password account, sessions persist via JWT
- Income, Bills, Purchases, and Debt entries — one-off or monthly recurring
- Per-month ledger with carry-forward balance and a "mark received/paid" flow
- Purchases and one-off bills can be paid from balance, off-balance, or charged to a card/loan
- Avalanche/snowball payoff planner with interest simulation, a payoff chart, and a
  "what if I paid more" calculator
- **Budget**: list your essentials (groceries, gas…) with monthly amounts. Each month's pay is
  split in order — bills, then debt minimums, then essentials — showing what's paid, set aside, or
  still short. What's left goes partly to an extra payment on the debt the payoff plan targets
  first (the "% to debt" slider, saved to your account) and the rest is free to spend. Give an
  essential store names (e.g. `costco, superstore`) to track spending against it.
- **Should I buy it?** — enter a price (and optionally what it is) and get Go for it / Wait / Don't
  buy now, with the reasons: whether it fits this month's free money, whether it would eat the
  extra debt payment or leave bills short, when you could afford it (from your usual free money
  and next payday, estimated from past pay dates), and what it costs your debt payoff.
- **All transactions** — one feed of every transaction from every connected bank and account
  (Plaid and SimpleFIN together), grouped by day, each tagged with its bank · account and whether
  it's Income, Spent, Moves or a Transfer between your own accounts, with a per-bank filter and
  money in/out per bank. On phones it's Money → All.
- Per-account currency setting
- Edit or delete any entry; per-user data isolation enforced at the API layer
- Optional bank sync via Plaid and/or SimpleFIN: link multiple banks, auto-sync credit card/loan
  balances, use the real account total as Balance, and sort transactions into Income,
  Purchases and Circulation — each row shows the bank account it came from, and the Income,
  Purchases and Circulation lists have a bank picker when more than one bank is connected

## Testing

```bash
npm test        # unit tests (payoff simulation, ledger date math, suggestions)
npx tsc --noEmit  # typecheck
```

## iOS build

See `IOS_BUILD.md` — a GitHub Actions workflow (`.github/workflows/build-ipa.yml`) builds an
unsigned IPA that points the Capacitor webview at your deployed URL.

## Production notes

- Set `NEXTAUTH_SECRET` to a long random value (`openssl rand -base64 32`) — never commit `.env`
- `npm run build` runs `prisma db push` against `DATABASE_URL` before building; for a team
  workflow with reviewable schema history, switch to `prisma migrate deploy` with committed
  migrations instead
- If you use Plaid, keep `PLAID_TOKEN_ENCRYPTION_KEY` outside git the same way — access tokens
  are stored encrypted, but losing that key or having it leak means rotating it and re-linking
  every bank
