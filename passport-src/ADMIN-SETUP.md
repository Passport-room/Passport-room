# Passport Room - Admin Panel & Public Stats Matching Setup

Admin page: https://YOUR-DOMAIN/admin  (static files in /admin, no build step)
Public stats: https://YOUR-DOMAIN/stats ("See how many people visit us")

## Public & Admin Matching
The public visitors page (/stats) and the admin dashboard (/admin) now display the **exact same 9 matched totals**:
1. **Total customers** (2,257) - matching the customer counter and historical customer base.
2. **Total visitors** (2,243) - cumulative unique visitors from customer records + live anonymous visitors.
3. **Total visits** (3,649) - cumulative visits across all sessions + live visits.
4. **Total photos created** (1,009) - cumulative photos created (983 historical + 26 recent).
5. **Today's visitors** - live visitors for today (UTC).
6. **Today's visits** - live visits for today (UTC).
7. **Photos created today** - photos created today (UTC).
8. **Total time spent** (571h 48m) - cumulative time spent across all user sessions.
9. **Community reviews** (17) - live review submissions.
10. **Referral answers** (8) - admin-only insight.

## Automatic Sync
- When an admin signs into `/admin`, the panel calculates the live database totals and automatically syncs them to the public `/stats` node via Firebase Realtime Database.
- You can also click the **"Sync public stats"** button in the admin header at any time.
- The public stats page (/stats) has built-in baseline fallback protection, ensuring it **never displays 0 or blank stats** even before the admin logs in.

## 1. Firebase Authentication
1. Firebase Console -> project `passport-48389` -> Authentication -> Sign-in method ->
   ensure **Email/Password** is enabled (keep **Anonymous** enabled for public visitors).
2. Users -> ensure your admin user `kok4you7@gmail.com` is present.
3. Realtime Database -> Data -> verify: `admins / <ADMIN_UID> = true`.

## 2. Security Rules Update
1. Open Firebase Console -> Realtime Database -> **Rules**.
2. Copy the updated contents of `database.rules.json` from this ZIP and click **Publish**.
   - Grants `.read: true` to `/stats` and `/reviews` for the public.
   - Grants admin write permission to each `/stats` child so the admin dashboard can sync totals (written per child).
   - Keeps `/customers` and `/referrals` admin-readable; the app itself writes customer records under a strict `CUS-######` pattern.

## 3. Deploy
Vercel deployment remains completely unchanged:
- Framework: Other
- Build Command: (empty)
- Output Directory: `.`
