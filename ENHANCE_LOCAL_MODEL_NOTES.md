# Local face enhancement (GPEN-BFR-256) — what changed & how to verify

## What changed
- `src/routes/api/public/enhance.ts` no longer calls any Hugging Face Gradio
  Space. It calls `enhanceFaceLocal()` in `src/server/gpen.ts`, which runs
  entirely on this server via `onnxruntime-node` (CPU).
- Request/response contract is unchanged: `POST /api/public/enhance` with
  multipart `image` + optional `upscale` (1–4), response is `image/png`.
- Restoration always runs at GPEN's full generative strength — there is no
  fidelity/strength parameter to tune down, so "max restoration strength, no
  fidelity-loss shortcuts" is simply the model's normal behavior here.
- No model weights are committed to the repo. On first request per cold
  start, two files are downloaded from Hugging Face into a runtime cache
  directory (`/tmp/models` on Vercel) and reused after that:
  - `scrfd_2.5g.onnx` (~3.3 MB) — face detector + 5-point landmarks
  - `GPEN-BFR-256.onnx` (~75.7 MB) — face restoration model
- `@gradio/client` and `HF_TOKEN` are still present because the separate
  virtual try-on feature (`src/routes/api/public/tryon.ts`) still uses them.
  Nothing there was touched.

## New dependencies
`package.json` now includes `onnxruntime-node` and `sharp`. Run `npm install`
(or your usual install command) after unzipping.

## ⚠️ Please test before relying on this in production
I built this without the ability to run it — my environment has no network
access and no way to execute ONNX inference, so I could not confirm two
specific details against the real model files:

1. **SCRFD output tensor names.** I assumed the common InsightFace/FaceFusion
   naming convention (`score_8`, `bbox_8`, `kps_8`, etc.). If this specific
   export names its outputs differently, face detection will silently return
   zero faces and every photo will fall back to "no face found" (original
   image passed through, untouched).
2. **GPEN-BFR-256 input/output normalization and tensor layout.** I assumed
   `[-1, 1]`-normalized RGB in `[1,3,256,256]` NCHW format, which is standard
   for this model family, but couldn't verify it against this exact file.

## How to check it's working
Both `scrfd.ts` and `gpen.ts` log their actual input/output tensor names and
shapes to the console **once**, the first time each model runs:

```
[scrfd] input names: [...] output names: [...]
[scrfd] output "score_8" dims: [...]
[gpen] input names: [...] output names: [...] output dims: [...]
```

Check your server/function logs after the first enhance request. If you see:

```
[scrfd] No output tensors matched expected score/bbox naming convention...
```

or

```
[enhance] face detection step failed, returning original image untouched: ...
[enhance] face restoration step failed, returning original image untouched: ...
```

that means the assumed layout didn't match this model export, and the code
is safely falling back to passing the original photo through (never
corrupting it) rather than failing the request. Send me those log lines and
I'll fix the tensor name matching / normalization to match.

You can also check the `X-Enhance-Face-Found: true|false` response header
on the `/api/public/enhance` call in your browser's network tab as a quick
signal of whether a face was actually detected and restored.
