// Bundles src/client/main.js into public/assets/app.min.js and the CodeFormer
// inference worker into public/assets/codeformer.worker.js.
//
// "three" and "onnxruntime-web/webgpu" stay external so the browser's importmap
// (in public/index.html) resolves them from the CDN at runtime. The worker
// imports onnxruntime directly from an https URL, which is kept external too.
import { build } from "esbuild";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "public/assets");

mkdirSync(outdir, { recursive: true });
// Clean previous outputs (main bundle + worker + any split chunks).
for (const f of ["app.min.js", "codeformer.worker.js"]) {
  const p = resolve(outdir, f);
  if (existsSync(p)) rmSync(p, { force: true });
}

const shared = {
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  treeShaking: true,
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: [resolve(root, "src/client/main.js")],
  outdir,
  entryNames: "app.min",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  external: ["three", "onnxruntime-web/webgpu", "https://*"],
});

await build({
  ...shared,
  entryPoints: [resolve(root, "src/client/codeformer.worker.js")],
  outdir,
  entryNames: "codeformer.worker",
  external: ["https://*"],
});

console.log("[build-client] bundled -> public/assets/app.min.js + codeformer.worker.js");
