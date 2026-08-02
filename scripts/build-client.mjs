// Bundles src/client/main.js into public/assets/app.min.js.
// "three" and "onnxruntime-web/webgpu" stay external so the browser's
// importmap (in public/index.html) resolves them from the CDN at runtime.
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "public/assets");

mkdirSync(outdir, { recursive: true });
// Clean previous outputs (main bundle + any split chunks).
for (const f of ["app.min.js"]) {
  const p = resolve(outdir, f);
  if (existsSync(p)) rmSync(p, { force: true });
}

const buildOptions = {
  entryPoints: [resolve(root, "src/client/main.js")],
  outdir,
  entryNames: "app.min",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: true,
  splitting: true,
  sourcemap: false,
  legalComments: "none",
  treeShaking: true,
  external: ["three", "onnxruntime-web/webgpu"],
  logLevel: "info",
};

let done = false;
try {
  const { build: nativeBuild } = await import("esbuild");
  await nativeBuild(buildOptions);
  done = true;
} catch (err) {
  console.warn("[build-client] Native esbuild failed, using esbuild-wasm fallback...", err?.message || err);
}

if (!done) {
  const eswasm = await import("esbuild-wasm");
  try {
    await eswasm.initialize({});
  } catch {
    // already initialized
  }
  await eswasm.build(buildOptions);
}

console.log("[build-client] bundled -> public/assets/app.min.js");
