# Global Rewards System — setup and operations

Rewards page: `https://passport-room.com/rewards`
Admin configuration: `https://passport-room.com/admin/rewards`
Postback endpoint: `https://passport-room.com/api/rewards/postback?provider=<provider-id>`

Nothing in this system pays out anything until **all four** steps below are done: Firebase
credentials on the server, the new database rules published, at least one provider configured,
and that provider's dashboard pointed at the postback URL with a matching secret. Until then the
page honestly reports “Rewards are not open yet” and the endpoint refuses every credit.

---

## 1. What was built

| Piece | Path | What it does |
| --- | --- | --- |
| Rewards page | `rewards/index.html`, `rewards/rewards.js`, `rewards/rewards.css` | Three tabs (survey walls, offerwalls, rewarded videos), balance, history, partner launches. Read-only: it never writes points. |
| Partner launch | `api/rewards/session.js` | Verifies the visitor's Firebase ID token, checks the daily cap, builds the provider URL **on the server** (so a hashing secret never reaches the browser). |
| Postback | `api/rewards/postback.js` | Receives the provider's server-to-server call, verifies its signature, applies the reward. |
| Ledger | `api/rewards/_lib/ledger.js` | Atomic credit / reversal with duplicate protection. |
| Admin API | `api/rewards/admin.js` | Admin-only lookup, reversal, configuration check. |
| Admin screen | `admin/rewards.html`, `admin/rewards-admin.js` | Enable rewards, set rates and caps, add/edit/delete providers, store secrets, look up users, reverse transactions. |
| Rules | `database.rules.json` (`rewards`, `rewardsSecrets`) | Clients may read the public config and their **own** balance/history. Clients may not write any reward data. |

Data layout in the Realtime Database:

```
rewards/
  config/settings                      public: enabled, unit, pointsPerUnit, caps
  config/providers/{id}                public: launch url template, parameter names, signature scheme
  users/{uid}/                         balance, lifetime totals, daily tallies, recent txn keys
  transactions/{uid}/{txnKey}          permanent audit row per credit/reversal
  ledger/{providerId}/{txnId}          create-only lock: one provider transaction pays once
rewardsSecrets/
  providers/{id}/secret                never readable by a browser; server-only
```

### Why a client cannot change a balance

* `database.rules.json` sets `.write: false` on `rewards/users`, `rewards/transactions` and
  `rewards/ledger`. Only the service account (used by the API functions) can write there, and
  service-account access bypasses rules by design.
* The browser has no code path that awards points: the rewards page only `GET`s its own nodes.
* Every balance change is a compare-and-swap using the Realtime Database conditional-request API
  (`X-Firebase-ETag` + `if-match`), so two simultaneous postbacks cannot overwrite each other.
* Each provider transaction id is first claimed with a create-only write (`if-match: null_etag`)
  under `rewards/ledger`. A repeat of the same transaction returns `duplicate` and credits nothing.
* A reversal is a **new** transaction row with negative points; the original row is never edited.

---

## 2. Firebase: create the server credentials

The postback endpoint needs to write with admin rights, which requires a service account.

1. Firebase console → project **passport-48389** → ⚙ **Project settings** → **Service accounts**.
2. Click **Generate new private key** → **Generate key**. A JSON file downloads.
3. In Vercel → your project → **Settings → Environment Variables**, add **one** of:

   * `FIREBASE_SERVICE_ACCOUNT_JSON` — the entire contents of that JSON file, pasted as one value.
     (Easiest and least error-prone.)
   * or `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` — the `client_email` and `private_key`
     fields. Keep the `\n` escapes exactly as the JSON file has them.

   Optional: `FIREBASE_DATABASE_URL` (defaults to
   `https://passport-48389-default-rtdb.firebaseio.com`).
4. Apply to **Production** (and Preview if you test there), then **redeploy** — Vercel only injects
   new variables into a new deployment.

Never commit that JSON file to the repository and never paste it into chat.

---

## 3. Publish the database rules

1. Firebase console → **Realtime Database → Rules**.
2. Replace the contents with `database.rules.json` from this ZIP and click **Publish**.
3. Verify: signed out, `GET /rewards/users/anything.json` must fail with *permission denied*;
   the rewards page's config read must succeed.

The rules added by this change:

* `rewards/config` — readable by anyone (it contains no secrets); writable only by UIDs under
  `/admins`.
* `rewards/users/{uid}` and `rewards/transactions/{uid}` — readable by that signed-in UID and by
  admins; **never writable by a client**.
* `rewards/ledger` — no client read, no client write.
* `rewardsSecrets` — no client read at all; writable only by admins (so the admin screen can save a
  secret but can never display one again).

Existing `/reviews`, `/customers`, `/referrals`, `/stats` and `/counters` rules are untouched.

---

## 4. Vercel: how the API is served

* Deploy with **Root Directory = `public`** (unchanged) and **Framework = Other**.
* The functions live in `public/api/…`, which Vercel detects automatically as Node functions.
* `public/package.json` marks the folder as ESM (`"type": "module"`), which the functions require.
* `public/vercel.json` sets `maxDuration: 30` for `api/**` and `Cache-Control: no-store` on API
  responses.
* Node 20+ on Vercel includes `fetch` and `node:crypto`; there are **no npm dependencies** to
  install for the API.

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `REWARDS_SECRET_<PROVIDER_ID>` | Provider secret kept in Vercel instead of the database. `<PROVIDER_ID>` is the provider id uppercased with non-alphanumerics replaced by `_` (e.g. `bitlabs` → `REWARDS_SECRET_BITLABS`). An env var always wins over the database value. |
| `REWARDS_ALLOWED_ORIGINS` | Comma-separated extra origins allowed to call `/api/rewards/session` and `/api/rewards/admin` (localhost is always allowed). |
| `REWARDS_DEBUG` | `true` adds the internal error message to admin API failures. Leave unset in production. |

---

## 5. Configure providers (this is what makes rewards real)

Open **`/admin/rewards`** and sign in with an account whose UID is `true` under `/admins`.

1. **Global settings** — set the unit (e.g. `USD`), points per unit (e.g. `1000` points per 1 USD),
   the daily earn cap, the minimum redemption, and leave **Rewards enabled = Off** until the first
   provider is fully wired.
2. **Add provider** with a short id (`bitlabs`, `cpx`, `ayet`, …). The id becomes part of the
   postback URL, so pick it before you configure the provider's dashboard.
3. Fill in the provider's details:
   * **Launch URL template** — the wall URL from the provider's docs, with `{uid}` where their
     visitor id goes, plus `{app_id}` if they use one. Example:
     `https://web.bitlabs.ai/?token=XXX&uid={uid}`.
   * **Postback parameters** — the names their postback uses for the visitor id, the amount and the
     transaction id (often `user_id` / `amount` / `trans_id`, but every network differs). A
     misnamed parameter means every postback is rejected as “invalid user”, which is the safe
     failure.
   * **Signature scheme** — choose what the provider actually sends:
     * `shared-secret` — the secret arrives back in a parameter (often `token` or a hash in `hash`).
     * `md5-uid` — a parameter equals `md5(uid + secret)` (common with `secure_hash`-style walls).
     * `hmac-sha256` — HMAC of `uid:trans_id:amount:secret` (adjust the field order to match their
       docs). Compared in constant time.
     * `none` — only for a provider that calls from a fixed IP and offers no secret. It is refused
       unless you also tick **Allow unsigned postbacks**; do not tick it otherwise.
   * **Max points per activity** — a hard ceiling per single postback, so a bug or a malicious
     payload cannot mint an unbounded balance.
4. **Save provider**, then **Save secret** with the shared secret from the provider's dashboard.
   The field is write-only: after saving, replace it if it rotates.
5. Copy the **Postback URL** shown on the provider card into that provider's dashboard (usually
   “S2S postback”, “server callback” or “postback URL”), and ask them to enable it for conversions
   **and** reversals.
6. Click **Check setup** — it reports, server-side, whether the secret is configured and whether the
   launch URL has every placeholder. Fix anything it lists.
7. Only when both are green: set **Rewards enabled = On** and save.

Each new network is a new provider entry — no code change. A provider that needs a signature
scheme not in the list above needs one case added to `api/rewards/_lib/verify.js`, and that is the
only place to touch.

### Tests the provider can run with you

* Ask the provider for their **test/sandbox postback** (most networks have one). A correct setup
  returns HTTP 200 `OK`, adds the points once, and appears in `/admin/rewards` → **User lookup**.
* Send the same test postback again: it must return 200 and **not** change the balance (duplicate).
* Send a postback with the wrong secret: it must return **401** and change nothing.
* Send a reversal status: the points are taken back and a separate negative row is written.
* There is deliberately **no “give me points” button** anywhere, including admin. The only credits
  that exist are ones a provider actually reported.

---

## 6. Provider approval checklist

Typical onboarding for a survey wall / offerwall / rewarded-video network:

1. Apply for a publisher account with your site (they usually review traffic quality, the site's
   content and its privacy policy first).
2. They issue an **app id / placement id** and a **secret** (sometimes called postback key or API
   key).
3. They ask for the **postback URL** and often for a list of allowed domains — give
   `https://passport-room.com` and `https://www.passport-room.com`, and the postback URL above.
4. Map their parameter names to the fields in the admin provider form.
5. Ask them to enable **reversal/chargeback callbacks**; without that a rejected survey stays
   credited.

This build does not hard-code any network: it supports the common mechanisms (URL placeholders,
parameter mapping, shared secret, MD5-of-uid, HMAC-SHA256, reversal statuses). Whatever the network
calls those, the admin form is where they are declared.

---

## 7. AdSense and policy

The rewards page intentionally loads **no AdSense code**. Mixing incentivised traffic with ads on
the same page is a policy risk, so the ad loader was left out of `rewards/index.html`; the rest of
the site keeps its existing AdSense setup unchanged. The rewards page also states plainly that
points are not cash, that payouts are manual, and that partners can reverse a completion.

---

## 8. Limitations (deliberate, so nothing is overstated)

* **Payouts are manual.** Points are recorded; paying them out is handled by a human after contact.
  There is no automatic withdrawal, no crypto payout, no payout API.
* **No KYC/tax handling.** Add it before paying meaningful amounts in any jurisdiction that
  requires it.
* **Duplicate protection is per provider transaction id.** If a provider reuses ids across
  campaigns, use their campaign-aware id field as the transaction parameter.
* **Daily caps and per-activity ceilings** are enforced on the server from the config; changing the
  config affects future events only.
* **Nothing is live until configured.** A fresh deployment shows “Rewards are not open yet” and
  rejects postbacks with 403/404. That is the intended, honest default.
