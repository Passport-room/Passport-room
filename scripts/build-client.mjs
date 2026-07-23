// Bundles src/client/main.js into public/assets/app.min.js.
// "three" and "onnxruntime-web/webgpu" stay external so the browser's
// importmap (in public/index.html) resolves them from the CDN at runtime.
import { build } from "esbuild";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "public/assets");
const bundle = resolve(outdir, "app.min.js");

mkdirSync(outdir, { recursive: true });
if (existsSync(bundle)) rmSync(bundle, { force: true });

await build({
  entryPoints: [resolve(root, "src/client/main.js")],
  outfile: resolve(outdir, "app.min.js"),
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  treeShaking: false,
  external: ["three", "onnxruntime-web/webgpu"],
  logLevel: "info",
});

console.log("[build-client] bundled -> public/assets/app.min.js");
