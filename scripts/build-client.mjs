// Bundles src/client/main.js into public/assets/app.min.js and the admin panel
// into public/assets/admin.min.js.
// "three" and "onnxruntime-web/webgpu" stay external so the browser's
// importmap (in public/index.html) resolves them from the CDN at runtime.
import { build } from "esbuild";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "public/assets");

mkdirSync(outdir, { recursive: true });
// Clean previous outputs (main bundle + any split chunks).
for (const f of ["app.min.js", "admin.min.js"]) {
  const p = resolve(outdir, f);
  if (existsSync(p)) rmSync(p, { force: true });
}

await build({
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
});

await build({
  entryPoints: [resolve(root, "src/client/admin.js")],
  outdir,
  entryNames: "admin.min",
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: true,
  splitting: false,
  sourcemap: false,
  legalComments: "none",
  treeShaking: true,
  logLevel: "info",
});

console.log("[build-client] bundled -> public/assets/app.min.js + admin.min.js");

/* Cache-busting: stamp the bundle and stylesheet URLs in public/index.html with
   a content hash so previews and published sites never serve a stale build. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const hashOf = (p) => createHash("md5").update(readFileSync(p)).digest("hex").slice(0, 10);

const htmlPath = resolve(root, "public/index.html");
const appHash = hashOf(resolve(outdir, "app.min.js"));
const cssPath = resolve(root, "public/style.css");
const cssHash = existsSync(cssPath) ? hashOf(cssPath) : null;

let html = readFileSync(htmlPath, "utf8");
html = html.replace(/src="assets\/app\.min\.js(?:\?v=[^"]*)?"/g, `src="assets/app.min.js?v=${appHash}"`);
if (cssHash) {
  html = html.replace(/href="style\.css(?:\?v=[^"]*)?"/g, `href="style.css?v=${cssHash}"`);
}
writeFileSync(htmlPath, html);

const adminHtmlPath = resolve(root, "public/admin/index.html");
if (existsSync(adminHtmlPath)) {
  const adminHash = hashOf(resolve(outdir, "admin.min.js"));
  let adminHtml = readFileSync(adminHtmlPath, "utf8");
  adminHtml = adminHtml.replace(
    /src="\/assets\/admin\.min\.js(?:\?v=[^"]*)?"/g,
    `src="/assets/admin.min.js?v=${adminHash}"`,
  );
  writeFileSync(adminHtmlPath, adminHtml);
}

console.log(`[build-client] cache-busted index.html (app=${appHash}, css=${cssHash})`);
