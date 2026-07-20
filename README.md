# Make.pics — Vercel deployment

Static passport-photo / virtual-try-on / HD-enhance app.

## Structure

```
public/          Static site (served at /)
api/public/      Vercel serverless functions
  tryon.ts       POST /api/public/tryon    (proxies yisol/IDM-VTON)
  enhance.ts     POST /api/public/enhance  (proxies sczhou/CodeFormer)
vercel.json      Function runtime + timeout config
```

No build step. Vercel serves `public/` as-is and compiles the two TypeScript
functions on deploy.

## Deploy

```bash
npm install       # or bun install
npx vercel        # first time
npx vercel --prod # production
```

## Plan config

Defaults are tuned for the **free Hobby plan**:

- `vercel.json` → `maxDuration: 60` (Hobby cap)
- handler internal `TIMEOUT_MS` = 55 000 ms (returns a clean 504 JSON before
  Vercel kills the function)

If you upgrade to **Vercel Pro** you can raise both:

1. `vercel.json` → `"maxDuration": 300`
2. `api/public/tryon.ts` → `const TIMEOUT_MS = 170_000;`
3. `api/public/enhance.ts` → `const TIMEOUT_MS = 220_000;`

That gives cold Hugging Face Spaces the full time they need to warm up.

## Environment (optional but recommended)

Cold Hugging Face Spaces can take 60–180 s to boot. Adding a free HF token
puts your requests in the authenticated queue (much faster, avoids public
throttling and reduces the 504s you see on the free plan):

1. Create a **read** token at https://huggingface.co/settings/tokens
2. In Vercel → **Project → Settings → Environment Variables** add:

   ```
   HF_TOKEN = hf_xxxxxxxxxxxxxxxxxxxx
   ```

3. Redeploy.

The handlers automatically pick it up (`process.env.HF_TOKEN`). Without it
they still work anonymously — just slower on cold starts.

## Troubleshooting

- **504 “AI took too long”** — Space is cold-booting. Retry in ~30 s, or
  add `HF_TOKEN`, or upgrade to Pro and raise the timeouts as above.
- **502 “Space error”** — the Hugging Face Space itself returned an error
  (upstream). The error message is passed through in the response body.
- **413 “image exceeds …”** — resize to under 8 MB (try-on) / 12 MB
  (enhance). Vercel’s own request-body limit is 4.5 MB by default; if the
  browser can’t POST, resize client-side first.
