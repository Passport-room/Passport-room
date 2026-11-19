# Offerwall.GG coins setup (Vercel + Firebase)

Deploy the `public` folder as the Vercel project root (Framework: Other, build command empty, output directory `.`).

1. Firebase Console -> Realtime Database -> Rules: merge the `wallets` rules from `database.rules.json` into your existing rules and Publish. Owners can read their own balance; clients cannot write coin balances. Keep your existing rules for the site's other data.
2. Firebase Console -> Project settings -> Service accounts -> Generate new private key.
3. Vercel -> Project -> Settings -> Environment Variables (Production):
   - `OFFERWALL_SECRET_KEY` = the placement's secret key
   - `FIREBASE_SERVICE_ACCOUNT` = the entire service-account JSON file contents
   - `FIREBASE_DATABASE_URL` = `https://passport-48389-default-rtdb.firebaseio.com` (optional)
   Redeploy afterwards. Never commit these values.
4. Offerwall.GG placement -> Postback URL (GET):
   `https://passport-room.com/api/postback?userId={userId}&transactionId={transactionId}&currencyAmount={currencyAmount}&status={status}&signature={signature}&test={test}`
   Add `passport-room.com` to the placement's allowed domains.
5. Use the dashboard test button. It should return `1` and credit nothing.

The `/earn` page uses the current Firebase visitor UID, shows its live coin balance, and embeds the wall. An accepted cookie choice is needed for the existing anonymous Firebase identity to start. Invalid signatures return 403. Test postbacks are acknowledged without a credit. Each transaction/status event is applied once atomically; negative reversal amounts subtract coins.

The server needs Node.js and installs `firebase-admin` from the package.json in this folder. Do not put the Offerwall secret or service-account JSON in browser code or source control.
