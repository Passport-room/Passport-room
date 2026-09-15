# AI Photo Studio

Virtual try-on and HD face-enhance for portrait photos, running on free public Hugging Face Spaces. Built on **TanStack Start** (React 19 + Vite 7) and deployed to Cloudflare Workers.

## Features

- **AI Dress Try-On** — powered by [`yisol/IDM-VTON`](https://huggingface.co/spaces/yisol/IDM-VTON). The server proxy letterboxes the person image to 3:4 before sending and crops the model output back to the original aspect ratio, so photos are never squashed.
- **AI Enhance** — face-safe super-resolution via [`sczhou/CodeFormer`](https://huggingface.co/spaces/sczhou/CodeFormer) with 2× / 4× upscale.
- **In-browser photo editor** — brightness, contrast, saturation, sharpness, clarity, and more; runs entirely on-device.
- **Background removal** — WebGPU via `onnxruntime-web`; no upload, no server.
- **Passport / visa photos** — country-specific specs with print-sheet composition.

No paid APIs, no signup, no personal data leaves your machine except the two AI calls to the public Spaces.

## Getting started

```bash
bun install
bun run dev
```

The dev server runs on <http://localhost:8080>. It serves the client at `/index.html`; `/` redirects there.

## Build

```bash
bun run build
```

`prebuild` bundles the client-side JS (`src/client/main.js`) into a single minified file at `public/assets/app.min.js`, then Vite builds the TanStack Start server + SSR shell.

## Deploy to Vercel

1. Push this repo to GitHub.
2. Import it in Vercel — leave the Framework Preset as **Other** (a `vercel.json` is included).
3. Click **Deploy**. No environment variables are required.

`vite.config.ts` detects Vercel's `VERCEL=1` build env and pins nitro's `vercel` preset, so the server routes under `/api/public/*` (try-on + enhance) are deployed as Node serverless functions and the Hugging Face Space calls work exactly as they do in the Lovable preview.

Function timeouts are capped at 55s to fit Vercel Hobby's 60s serverless limit. If a Hugging Face Space is cold-starting and the first call times out, retry — the UI already surfaces a friendly retry message.

## Project structure

```text
├── public/                    Static assets served as-is
│   ├── index.html             Main UI (loads one bundled script)
│   ├── style.css
│   ├── manifest.webmanifest
│   ├── robots.txt
│   └── favicon.ico
├── scripts/
│   └── build-client.mjs       esbuild bundler for the client
├── src/
│   ├── client/                Client-side source (bundled → public/assets/app.min.js)
│   │   ├── main.js            Bundle entry
│   │   ├── app.js             UI wiring
│   │   ├── dress-tryon.js     Try-On flow
│   │   ├── enhance.js         CodeFormer enhance flow
│   │   ├── photo-editor.js    In-browser adjustments
│   │   ├── background-removal.js
│   │   ├── crystal.js         Decorative WebGL
│   │   ├── passport-render.js
│   │   └── passport-specs.js
│   ├── routes/
│   │   ├── __root.tsx         Root layout / metadata
│   │   ├── index.tsx          Redirect to /index.html
│   │   └── api/public/
│   │       ├── tryon.ts       IDM-VTON proxy (letterbox + crop-back)
│   │       └── enhance.ts     CodeFormer proxy
│   ├── lib/                   Error reporting + utils
│   ├── hooks/
│   ├── router.tsx
│   ├── server.ts
│   ├── start.ts
│   └── styles.css
├── package.json
├── vite.config.ts
├── tsconfig.json
└── README.md
```

## Deploy

The project targets Cloudflare Workers via TanStack Start's Nitro Cloudflare preset. Any push to your connected host will run `bun run build`, which bundles the client and builds the server. No environment variables are required — both Hugging Face Spaces are public.

## License

MIT

## Hosting on GitHub + Vercel

Nothing extra to configure. The visitor number and the admin panel talk to the
cloud with the publishable key that is already in the code
(`src/client/cloud-config.js` and `src/lib/cloud.ts`), so no environment
variables or secret keys are needed on Vercel.

Admin panel: `/admin`. The secret is stored in the cloud (table
`admin_config`), current value `PassportRoom-Admin-2026`.
