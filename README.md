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

## Plan requirement

`vercel.json` sets `maxDuration: 300` (5 min) to accommodate slow cold-start
responses from Hugging Face Spaces (matches the original 170s / 220s
internal timeouts).

- **Vercel Pro / Enterprise** — works out of the box.
- **Vercel Hobby** — hard cap is 60s per function. Change both entries in
  `vercel.json` to `"maxDuration": 60`. Cold-Space calls may occasionally
  timeout; the client will show the standard "AI took too long" message.

## Environment

No environment variables required — Gradio Spaces are called anonymously.
