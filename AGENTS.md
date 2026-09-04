<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Do not re-introduce the background-removal tab crash

Background removal (MODNet via onnxruntime-web) previously crashed the whole
browser tab ("Aw, Snap!") on phones and some PCs. A tab crash is not a JS
exception — it cannot be caught, only prevented. The safeguards live in:

- `src/client/crash-guard.js` — crash memory (localStorage breadcrumbs), WebGPU
  gating, exclusive run queue, safe work size, canvas release. Read its header
  comment before editing any AI code.
- `src/client/background-removal.js` — fp16 model for WebGPU / fp32 for WASM,
  capped inference resolution, tensor disposal, friendly error instead of a
  stuck spinner.
- `src/client/model-cache.js` — `createSession()` gates WebGPU through the crash
  guard and always keeps the WASM fallback; `releaseModelBytes()` frees the
  duplicate weight buffer.

Hard rules: never force `executionProviders: ["webgpu"]`, never feed the fp16
graph to the WASM backend, never run two ONNX models concurrently (use
`withExclusiveRun`), never inference at full photo resolution, never remove the
`markStart()`/`markDone()` breadcrumbs, and never rename the localStorage keys.
