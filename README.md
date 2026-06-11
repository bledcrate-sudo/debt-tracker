# Debt Tracker

Modern Next.js + React debt/income/expense tracker. Account login, SQLite-backed persistence.

## Setup

```bash
cd debt-tracker
npm install
npx prisma db push
npm run dev
```

Open http://localhost:3000 — register, log in, add entries.

## Stack

- Next.js 14 (App Router) + React 18
- NextAuth (credentials) + bcrypt
- Prisma + SQLite (`prisma/dev.db`)
- Tailwind CSS

## Features

- Email/password account, sessions persist via JWT
- Add custom Income, Expense, Debt entries (label + amount + note)
- Live totals: Balance = Income − Expenses − Debt
- Filter by type, delete entries
- Per-user data isolation enforced at API layer

## Production notes

- Change `NEXTAUTH_SECRET` in `.env` to a long random value
- Swap SQLite for Postgres by updating `prisma/schema.prisma` `datasource` and re-running `prisma db push`
