// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// When building on Vercel, VERCEL=1 is set — hard-pin nitro's vercel preset so the
// server routes (`/api/public/*`) deploy as Node serverless functions instead of
// being served as static files (which is what caused the 500 errors on Vercel).
// Inside Lovable's own build, the plugin forces the Cloudflare preset regardless,
// so the preview keeps working exactly as before.
const nitroOptions =
  process.env.VERCEL || process.env.NITRO_PRESET === "vercel" ? { preset: "vercel" } : undefined;

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    server: { entry: "server" },
  },
  ...(nitroOptions ? { nitro: nitroOptions } : {}),
});
