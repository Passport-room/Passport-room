// Local face restoration using GPEN-BFR-256 (ONNX, CPU inference via
// onnxruntime-node). Runs entirely on this server — no external API calls.
//
// Pipeline:
//  1. Detect the face + 5-point landmarks with SCRFD.
//  2. Warp the face into the model's canonical 256x256 alignment (ArcFace
//     reference template) using an affine transform.
//  3. Run GPEN-BFR-256 at full strength (the model has no fidelity/strength
//     knob — it always outputs its full generative restoration; that is the
//     "max restoration strength, no fidelity-loss shortcut" setting here).
//  4. Warp the restored face back into the original image geometry and
//     blend it in with a soft elliptical mask, preserving the rest of the
//     photo untouched.
//  5. Optionally upscale the final image with a simple high-quality resize
//     to honor the requested "upscale" factor (matches prior API contract).

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { ScrfdDetector, type FaceDetection } from "./scrfd";
import { ensureModel, MODELS } from "./model-cache";

const ALIGN_SIZE = 256;

// Standard ArcFace 5-point reference template, scaled to 256x256.
// (L-eye, R-eye, nose, L-mouth, R-mouth)
const REFERENCE_LANDMARKS: Array<[number, number]> = [
  [88.0, 96.0],
  [168.0, 96.0],
  [128.0, 142.0],
  [98.0, 190.0],
  [158.0, 190.0],
];

type Mat2x3 = [number, number, number, number, number, number]; // a b c d e f -> [a c e; b d f]

/** Least-squares similarity transform (no reflection) mapping src points -> dst points. */
function estimateSimilarityTransform(
  src: Array<[number, number]>,
  dst: Array<[number, number]>,
): Mat2x3 {
  const n = src.length;
  let srcMeanX = 0,
    srcMeanY = 0,
    dstMeanX = 0,
    dstMeanY = 0;
  for (let i = 0; i < n; i++) {
    srcMeanX += src[i][0];
    srcMeanY += src[i][1];
    dstMeanX += dst[i][0];
    dstMeanY += dst[i][1];
  }
  srcMeanX /= n;
  srcMeanY /= n;
  dstMeanX /= n;
  dstMeanY /= n;

  let sxx = 0,
    syy = 0,
    sxy = 0,
    syx = 0,
    srcVar = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - srcMeanX;
    const sy = src[i][1] - srcMeanY;
    const dx = dst[i][0] - dstMeanX;
    const dy = dst[i][1] - dstMeanY;
    sxx += sx * dx;
    syy += sy * dy;
    sxy += sx * dy;
    syx += sy * dx;
    srcVar += sx * sx + sy * sy;
  }

  const a = (sxx + syy) / srcVar;
  const b = (sxy - syx) / srcVar;
  const tx = dstMeanX - (a * srcMeanX - b * srcMeanY);
  const ty = dstMeanY - (b * srcMeanX + a * srcMeanY);

  // Maps [x,y,1] -> [a*x - b*y + tx, b*x + a*y + ty]
  return [a, b, -b, a, tx, ty];
}

function invertAffine(m: Mat2x3): Mat2x3 {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  const ie = -(ia * e + ic * f);
  const iff = -(ib * e + id * f);
  return [ia, ib, ic, id, ie, iff];
}

/** Applies an affine transform to warp `src` into a `size`x`size` canvas via bilinear sampling. */
async function warpAffine(
  src: sharp.Sharp,
  srcW: number,
  srcH: number,
  matrix: Mat2x3,
  outSize: number,
): Promise<{ data: Buffer; channels: number }> {
  const { data: srcData, info } = await src
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const inv = invertAffine(matrix);
  const out = Buffer.alloc(outSize * outSize * channels);

  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      const sx = inv[0] * x + inv[2] * y + inv[4];
      const sy = inv[1] * x + inv[3] * y + inv[5];
      const outIdx = (y * outSize + x) * channels;

      if (sx < 0 || sy < 0 || sx >= srcW - 1 || sy >= srcH - 1) {
        continue; // leave as zero (transparent/black)
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      for (let c = 0; c < channels; c++) {
        const p00 = srcData[(y0 * srcW + x0) * channels + c];
        const p10 = srcData[(y0 * srcW + x0 + 1) * channels + c];
        const p01 = srcData[((y0 + 1) * srcW + x0) * channels + c];
        const p11 = srcData[((y0 + 1) * srcW + x0 + 1) * channels + c];
        const val =
          p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
        out[outIdx + c] = Math.round(val);
      }
    }
  }
  return { data: out, channels };
}

/** Warps a `size`x`size` source image back into `dstW`x`dstH` using the inverse of `matrix`, with bilinear sampling. */
async function warpAffineBack(
  faceData: Buffer,
  faceSize: number,
  channels: number,
  matrix: Mat2x3,
  dstW: number,
  dstH: number,
): Promise<{ rgb: Buffer; mask: Buffer }> {
  const rgb = Buffer.alloc(dstW * dstH * 3);
  const mask = Buffer.alloc(dstW * dstH); // soft blend mask (0..255)

  // Precompute an elliptical soft mask in face-space to feather the seam.
  const cx = faceSize / 2;
  const cy = faceSize / 2;
  const rx = faceSize * 0.5;
  const ry = faceSize * 0.5;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const fx = matrix[0] * x + matrix[2] * y + matrix[4];
      const fy = matrix[1] * x + matrix[3] * y + matrix[5];
      if (fx < 0 || fy < 0 || fx >= faceSize - 1 || fy >= faceSize - 1) continue;

      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const dstIdx = (y * dstW + x) * 3;

      for (let c = 0; c < 3; c++) {
        const p00 = faceData[(y0 * faceSize + x0) * channels + c];
        const p10 = faceData[(y0 * faceSize + x0 + 1) * channels + c];
        const p01 = faceData[((y0 + 1) * faceSize + x0) * channels + c];
        const p11 = faceData[((y0 + 1) * faceSize + x0 + 1) * channels + c];
        const val = p00 * (1 - tx) * (1 - ty) + p10 * tx * (1 - ty) + p01 * (1 - tx) * ty + p11 * tx * ty;
        rgb[dstIdx + c] = Math.round(val);
      }

      // Normalized elliptical distance for soft feathering (1 at center, 0 at edge).
      const nx = (fx - cx) / rx;
      const ny = (fy - cy) / ry;
      const d = Math.sqrt(nx * nx + ny * ny);
      const alpha = d < 0.75 ? 1 : d < 1 ? (1 - d) / 0.25 : 0;
      mask[y * dstW + x] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
    }
  }

  return { rgb, mask };
}

let scrfdPromise: Promise<ScrfdDetector> | null = null;
let gpenSessionPromise: Promise<ort.InferenceSession> | null = null;
let loggedGpenShapes = false;

async function getScrfd(): Promise<ScrfdDetector> {
  if (!scrfdPromise) {
    scrfdPromise = ensureModel(MODELS.scrfd).then((path) => ScrfdDetector.load(path));
  }
  return scrfdPromise;
}

async function getGpenSession(): Promise<ort.InferenceSession> {
  if (!gpenSessionPromise) {
    gpenSessionPromise = ensureModel(MODELS.gpenBfr256).then((path) =>
      ort.InferenceSession.create(path, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      }),
    );
  }
  return gpenSessionPromise;
}

async function runGpenOnAlignedFace(aligned: Buffer, channels: number): Promise<Buffer> {
  const session = await getGpenSession();

  // HWC uint8 RGB(A) -> CHW float32 in [-1, 1], matching GPEN's training normalization.
  const plane = ALIGN_SIZE * ALIGN_SIZE;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const r = aligned[i * channels];
    const g = aligned[i * channels + 1];
    const b = aligned[i * channels + 2];
    chw[i] = r / 127.5 - 1;
    chw[plane + i] = g / 127.5 - 1;
    chw[2 * plane + i] = b / 127.5 - 1;
  }

  const inputTensor = new ort.Tensor("float32", chw, [1, 3, ALIGN_SIZE, ALIGN_SIZE]);
  const inputName = session.inputNames[0];
  const outputs = await session.run({ [inputName]: inputTensor });
  const outputName = session.outputNames[0];
  const outData = outputs[outputName].data as Float32Array;
  const outDims = outputs[outputName].dims; // [1, 3, H, W]

  if (!loggedGpenShapes) {
    loggedGpenShapes = true;
    console.log(
      "[gpen] input names:",
      session.inputNames,
      "output names:",
      session.outputNames,
      "output dims:",
      outDims,
    );
  }

  if (!outDims || outDims.length !== 4 || outDims[1] !== 3) {
    throw new Error(
      `Unexpected GPEN output shape ${JSON.stringify(outDims)} — model export may differ from assumed [1,3,H,W] RGB layout`,
    );
  }

  const outH = outDims[2];
  const outW = outDims[3];
  const outPlane = outH * outW;

  // CHW float32 in [-1, 1] -> HWC uint8 RGB
  const restored = Buffer.alloc(outW * outH * 3);
  for (let i = 0; i < outPlane; i++) {
    const r = ((outData[i] + 1) / 2) * 255;
    const g = ((outData[outPlane + i] + 1) / 2) * 255;
    const b = ((outData[2 * outPlane + i] + 1) / 2) * 255;
    restored[i * 3] = Math.max(0, Math.min(255, Math.round(r)));
    restored[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(g)));
    restored[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(b)));
  }

  // GPEN-BFR-256 outputs at 256x256; if a different size ever ships, resize to match.
  if (outW !== ALIGN_SIZE || outH !== ALIGN_SIZE) {
    return sharp(restored, { raw: { width: outW, height: outH, channels: 3 } })
      .resize(ALIGN_SIZE, ALIGN_SIZE)
      .raw()
      .toBuffer();
  }
  return restored;
}

/**
 * Restores the primary face in `imageBuffer` at maximum GPEN restoration
 * strength and returns a PNG buffer of the full image with the enhanced
 * face blended back in place. If no face is detected, returns the original
 * image untouched (so the caller can decide how to handle that case).
 */
export async function enhanceFaceLocal(
  imageBuffer: Buffer,
  upscale: number,
): Promise<{ buffer: Buffer; faceFound: boolean }> {
  const detector = await getScrfd();
  const meta = await sharp(imageBuffer).metadata();
  const srcW = meta.width!;
  const srcH = meta.height!;

  let face: FaceDetection | null;
  try {
    face = await detector.detectPrimaryFace(imageBuffer);
  } catch (err) {
    console.error(
      "[enhance] face detection step failed, returning original image untouched:",
      err instanceof Error ? err.stack || err.message : err,
    );
    const out = await applyUpscale(imageBuffer, srcW, srcH, upscale);
    return { buffer: out, faceFound: false };
  }

  const baseImage = sharp(imageBuffer).ensureAlpha();
  const { data: baseData } = await baseImage.raw().toBuffer({ resolveWithObject: true });

  if (!face || face.landmarks.length !== 5) {
    // No face found — return the (optionally upscaled) original untouched.
    const out = await applyUpscale(imageBuffer, srcW, srcH, upscale);
    return { buffer: out, faceFound: false };
  }

  const matrix = estimateSimilarityTransform(face.landmarks, REFERENCE_LANDMARKS);

  try {
    const { data: alignedFace, channels } = await warpAffine(
      sharp(imageBuffer).ensureAlpha(),
      srcW,
      srcH,
      matrix,
      ALIGN_SIZE,
    );

    const restoredFace = await runGpenOnAlignedFace(alignedFace, channels);

    const { rgb: pastedRgb, mask } = await warpAffineBack(
      restoredFace,
      ALIGN_SIZE,
      3,
      matrix,
      srcW,
      srcH,
    );

    // Alpha-blend restored face region into the original image using the soft mask.
    const outChannels = 4;
    const blended = Buffer.alloc(srcW * srcH * outChannels);
    for (let i = 0; i < srcW * srcH; i++) {
      const alpha = mask[i] / 255;
      const baseIdx = i * 4;
      const pasteIdx = i * 3;
      blended[baseIdx] = Math.round(pastedRgb[pasteIdx] * alpha + baseData[baseIdx] * (1 - alpha));
      blended[baseIdx + 1] = Math.round(
        pastedRgb[pasteIdx + 1] * alpha + baseData[baseIdx + 1] * (1 - alpha),
      );
      blended[baseIdx + 2] = Math.round(
        pastedRgb[pasteIdx + 2] * alpha + baseData[baseIdx + 2] * (1 - alpha),
      );
      blended[baseIdx + 3] = baseData[baseIdx + 3];
    }

    const blendedPng = await sharp(blended, {
      raw: { width: srcW, height: srcH, channels: 4 },
    })
      .png()
      .toBuffer();

    const out = await applyUpscale(blendedPng, srcW, srcH, upscale);
    return { buffer: out, faceFound: true };
  } catch (err) {
    // Any failure here (unexpected model I/O layout, corrupt weights, etc.)
    // should not corrupt the user's photo or hard-fail the request — log it
    // loudly for diagnosis and fall back to returning the original image.
    console.error(
      "[enhance] face restoration step failed, returning original image untouched:",
      err instanceof Error ? err.stack || err.message : err,
    );
    const out = await applyUpscale(imageBuffer, srcW, srcH, upscale);
    return { buffer: out, faceFound: false };
  }
}

async function applyUpscale(
  imageBuffer: Buffer,
  srcW: number,
  srcH: number,
  upscale: number,
): Promise<Buffer> {
  if (!upscale || upscale <= 1) {
    return sharp(imageBuffer).png().toBuffer();
  }
  const targetW = Math.round(srcW * upscale);
  const targetH = Math.round(srcH * upscale);
  return sharp(imageBuffer)
    .resize(targetW, targetH, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
}
