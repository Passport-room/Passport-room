// Downloads ONNX model weights into a writable runtime cache directory the
// first time they're needed, then reuses that file on every later call.
// Models are NOT committed to the repo — they are fetched from Hugging Face
// on demand, verified by size, and cached on local disk (Vercel: /tmp,
// which is writable and persists for the life of a warm function instance).

import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

export type ModelSpec = {
  /** File name used on disk, e.g. "gpen-bfr-256.onnx" */
  fileName: string;
  /** Direct HTTPS download URL (Hugging Face "resolve/main" link). */
  url: string;
  /** Expected file size in bytes, used as a sanity check after download. */
  expectedBytes: number;
};

function cacheDir(): string {
  // /tmp is the only writable path on Vercel/most serverless runtimes.
  // Falls back to a local .cache folder for local dev.
  return process.env.MODEL_CACHE_DIR || (process.env.VERCEL ? "/tmp/models" : join(process.cwd(), ".cache", "models"));
}

const inFlight = new Map<string, Promise<string>>();

async function fileIsValid(path: string, expectedBytes: number): Promise<boolean> {
  try {
    const s = await stat(path);
    // Allow some tolerance (Xet/LFS re-uploads can shift a few KB).
    return s.isFile() && s.size > expectedBytes * 0.9;
  } catch {
    return false;
  }
}

async function downloadTo(url: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part-${process.pid}-${Date.now()}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Model download failed (${res.status}) for ${url}`);
  }
  const nodeStream = (await import("node:stream")).Readable.fromWeb(
    res.body as unknown as import("node:stream/web").ReadableStream,
  );
  try {
    await pipeline(nodeStream, createWriteStream(tmpPath));
    await rename(tmpPath, destPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// Known model specs used by the local face-enhance pipeline. Kept in one
// place so the exact source URLs and expected sizes are easy to audit.
export const MODELS = {
  // Face detector + 5-point landmarks (for aligning faces before restoration).
  scrfd: {
    fileName: "scrfd_2.5g.onnx",
    url: "https://huggingface.co/JackCui/facefusion/resolve/main/scrfd_2.5g.onnx",
    expectedBytes: 3_450_000, // ~3.29 MB
  } as ModelSpec,
  // GPEN-BFR-256: lightweight blind face-restoration model (CVPR'21), used
  // here at maximum restoration strength (full generative prior, no
  // fidelity-blend shortcut) in place of the previous Hugging Face Space calls.
  gpenBfr256: {
    fileName: "gpen-bfr-256.onnx",
    url: "https://huggingface.co/OwlMaster/AllFilesRope/resolve/main/GPEN-BFR-256.onnx",
    expectedBytes: 79_400_000, // ~75.7 MB
  } as ModelSpec,
};

/** Ensures the given model is present on local disk; downloads if missing. Returns the local file path. */
export async function ensureModel(spec: ModelSpec): Promise<string> {
  const destPath = join(cacheDir(), spec.fileName);

  if (await fileIsValid(destPath, spec.expectedBytes)) return destPath;

  const existing = inFlight.get(spec.fileName);
  if (existing) return existing;

  const task = (async () => {
    if (!(await fileIsValid(destPath, spec.expectedBytes))) {
      await downloadTo(spec.url, destPath);
      if (!(await fileIsValid(destPath, spec.expectedBytes))) {
        throw new Error(`Downloaded model ${spec.fileName} looks incomplete/corrupt`);
      }
    }
    return destPath;
  })();

  inFlight.set(spec.fileName, task);
  try {
    return await task;
  } finally {
    inFlight.delete(spec.fileName);
  }
}
