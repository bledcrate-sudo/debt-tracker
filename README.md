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
