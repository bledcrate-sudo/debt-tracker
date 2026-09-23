# Debt Tracker

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

Sandbox is free and unlimited. Moving to real accounts needs Plaid's Trial plan (also free, up to
10 linked accounts) — just swap `PLAID_ENV` to `production` and use your production `secret`.

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
- Per-account currency setting
- Edit or delete any entry; per-user data isolation enforced at the API layer
- Optional Plaid integration: link multiple banks, auto-sync credit card/loan balances and
  terms, import recent checking-account transactions

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
