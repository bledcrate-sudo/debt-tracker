# iOS .ipa build guide

Capacitor wraps this Next.js app in a WKWebView shell so it ships as a native iOS app. Auth + database stay on your hosted Next.js server; the app just loads it.

## Architecture

```
iPhone (.ipa)
   │
   └── WKWebView ── HTTPS ──> Your hosted Next.js
                                  (NextAuth + Prisma + SQLite/Postgres)
```

You MUST deploy the Next.js app somewhere first (Vercel free tier works).

---

## Step 1 — Deploy the Next.js app

Easiest: Vercel.
```bash
npm i -g vercel
vercel
```
Switch DB from SQLite to Postgres for production (Vercel Postgres or Neon free tier). Update `prisma/schema.prisma`:
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```
Set env vars on Vercel: `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL=https://your-app.vercel.app`.

Note the deployed URL — you'll need it.

---

## Step 2 — Build the unsigned .ipa

### Option A — GitHub Actions (no Mac required) ⭐ recommended

1. Push this repo to GitHub.
2. Go to **Actions → Build unsigned iOS IPA → Run workflow**.
3. Enter your deployed URL (e.g. `https://your-app.vercel.app`).
4. Wait ~10–15 min.
5. Download `DebtTracker-unsigned-ipa` artifact → unzip → you have `DebtTracker-unsigned.ipa`.

Workflow file: `.github/workflows/build-ipa.yml`.

### Option B — On a Mac with Xcode

```bash
export CAP_SERVER_URL=https://your-app.vercel.app
npm ci
npx cap add ios
npx cap sync ios
cd ios/App && pod install
open App.xcworkspace
# In Xcode: Product → Archive → Distribute → Development → Export
```

---

## Step 3 — Sign + install on iPhone (third party)

Apple requires `.ipa` to be signed before installing. Pick one:

| Tool | Cost | Re-sign frequency | Notes |
|------|------|-------------------|-------|
| **AltStore** (altstore.io) | Free | Every 7 days | Uses free Apple ID, computer must be on same network weekly |
| **Sideloadly** (sideloadly.io) | Free | Every 7 days | Windows + Mac, free Apple ID |
| **TrollStore** | Free | Permanent | iOS 14.0–16.6.1 / 17.0 only — no resign needed |
| **AltStore PAL** (EU only) | Free | Permanent | EU iPhones, iOS 17.4+ |
| **ESign / Scarlet** | Free | Varies | Enterprise certs — risky, may revoke |
| **Apple Developer cert** ($99/yr) | $99 | 1 year | Real distribution-ready cert |

### Quickest: Sideloadly (Windows-friendly)

1. Install Sideloadly: https://sideloadly.io/
2. Plug iPhone in via USB.
3. Drag `DebtTracker-unsigned.ipa` into Sideloadly.
4. Sign in with your Apple ID (free is fine).
5. Click **Start** → app installs.
6. On iPhone: **Settings → General → VPN & Device Management → trust your Apple ID**.

App appears on home screen. Opens the Next.js site in a native WKWebView shell — feels like a native app, full-screen, no Safari UI.

---

## Bundle ID + signing notes

- Default bundle id: `com.debttracker.app` — change in `capacitor.config.ts` if you hit conflicts.
- Free Apple ID limits: 3 sideloaded apps at a time, 7-day expiration.
- The `.ipa` artifact GH Actions produces has `CODE_SIGNING_ALLOWED=NO` so it's ready for re-signing by any tool above.

---

## Local dev on real iPhone (without rebuilding .ipa)

Easier loop while iterating: 
1. Run `npm run dev` (binds 0.0.0.0:5000).
2. Find your computer's LAN IP: `ipconfig` → IPv4 (e.g. `192.168.1.50`).
3. Set `CAP_SERVER_URL=http://192.168.1.50:5000` and `cleartext: true` in `capacitor.config.ts`.
4. Rebuild .ipa once with that URL — every code change on your laptop is reflected instantly in the app.
