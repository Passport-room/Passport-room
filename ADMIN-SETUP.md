# Passport Room - Admin panel setup

Admin page: https://YOUR-DOMAIN/admin  (static files in /admin, no build step)

## What it shows (read-only)
- /customers  - historical visitor records: customer number, name (if stored), visits,
  images created (photoCount), time spent (totalMs), country, device, first/last visit.
- /reviews    - current reviews with timestamp, rating, text, source, customerId, uid, deviceId.
- /referrals  - "Where did you hear about our website?" answers with timestamp and visitor UID.
The page never writes, resets or deletes any database record.

## 1. Create the admin login (Firebase Authentication)
1. Firebase Console -> project passport-48389 -> Authentication -> Sign-in method ->
   enable "Email/Password" (keep "Anonymous" enabled; the public site uses it).
2. Authentication -> Users -> Add user -> your admin email + a strong password.
3. Copy that user's "User UID".
The password lives only in Firebase Authentication. It is not in this ZIP.

## 2. Mark that account as admin
Realtime Database -> Data -> at the root add:   admins / <ADMIN_UID>  =  true   (boolean)
Only the Firebase Console (or a service account) can write here; the rules forbid writes from the site.

## 3. Security rules
1. Realtime Database -> Rules. FIRST copy the current live rules and save them somewhere (backup).
2. Merge database.rules.json from this ZIP. It:
   - lets only admins read /customers, /referrals, /counters, /devices;
   - makes /customers read-only for everyone (the current site no longer writes it,
     so historical rows cannot be overwritten or reset);
   - keeps /reviews publicly readable because the public review wall on the homepage reads it;
   - keeps review / referral submissions as create-only (no edits or deletes);
   - /stats stays public-read, +1 increments only.
3. Use "Rules Playground" to test: unauthenticated read of /customers must be denied;
   read as your admin UID must be allowed. Then Publish.
Changing rules never deletes data.

Privacy note: because /reviews is publicly readable, its uid / deviceId / customerId fields are
public too. If that is not acceptable, the public review wall must be changed to read a
sanitized copy instead - this was not changed to avoid breaking the current site.

## 4. Environment variables
None are needed. The Firebase web config in the JS files is a public identifier, not a secret.
Never put a database secret, service-account JSON or admin password in this folder or in
Vercel "Environment Variables" for this static site - nothing here would use them safely.

## Deploy (unchanged)
Vercel: framework "Other", empty build command, output directory "."

## Update (stats page + reviews)
After uploading this version, open Firebase Console > Realtime Database > Rules, paste the contents of database.rules.json and click Publish.
This lets the public stats page show the customer count, total and today visits, photos today and total time spent (the same numbers shown in the admin panel).
