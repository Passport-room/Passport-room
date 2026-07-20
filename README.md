# Make.pics

Static passport-photo / virtual try-on site, deployed on Vercel as static
assets + two serverless functions.

## Structure

```
public/                  static site (served as-is, unchanged)
  index.html
  style.css
  app.js
  crystal.js
  photo-editor.js
  passport-render.js
  background-removal.js
  enhance.js
  dress-tryon.js
  passport-specs.js
  favicon.ico
  robots.txt
  manifest.webmanifest
  assets/                clothing overlay images
api/public/
  enhance.js             POST /api/public/enhance  (face-restoration proxy)
  tryon.js                POST /api/public/tryon    (virtual try-on proxy)
vercel.json
package.json
```

## Deploy

```
npm install
vercel deploy
```

No environment variables are required; the two API routes proxy to public
Hugging Face Spaces (`sczhou/CodeFormer` and `yisol/IDM-VTON`).

Note: `enhance` and `tryon` can take up to ~220s / ~170s on a cold Space.
`vercel.json` sets `maxDuration` accordingly — this requires a Vercel plan
that supports function durations beyond the default 10s (Pro or Fluid
Compute on Hobby).
