// Face restoration — clean rebuild around GPEN-BFR-256.
//
// Pipeline (nothing more, nothing less):
//   original image
//     -> face detection + 5 landmarks (on-device YOLO-Face)
//     -> similarity alignment onto the FFHQ 256 template (uniform scale, no stretch)
//     -> GPEN-BFR-256 restoration
//     -> gentle tone match + geometry confidence check
//     -> inverse warp with a soft feathered face mask, controlled blend
//     -> optional very light unsharp when the face is much larger than 256
//     -> composited back into the untouched original
//
// Deliberately NOT done here (all of it hurt quality before):
//   * no pasting original eye pixels back on top
//   * no high-frequency "detail transfer" from the blurry source
//   * no skin smoothing / bilateral filter
//   * no multi-stage sharpening
//   * no full-image processing — only the aligned face patch is touched

import {
  MODEL_KEYS,
  getModelBytes,
  createSession,
  isModelSaved,
  releaseModelBytes,
} from "./model-cache.js";
import { detectFace } from "./face-detector.js";

const MODEL_URL = "https://huggingface.co/facefusion/models-3.0.0/resolve/main/gpen_bfr_256.onnx";
const SIZE = 256;

// FFHQ 5-point template (left eye, right eye, nose, left mouth, right mouth),
// normalised — the exact layout GPEN-BFR was trained on.
const TEMPLATE = [
  [0.37691676, 0.46864664],
  [0.62285697, 0.46912813],
  [0.5012386, 0.61331904],
  [0.39308822, 0.725411],
  [0.61150205, 0.72490465],
].map(([x, y]) => ({ x: x * SIZE, y: y * SIZE }));

let modelPromise = null;

export function isFaceModelSaved() {
  return isModelSaved(MODEL_KEYS.GPEN);
}

export function loadFaceModel(onProgress) {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const bytes = await getModelBytes(MODEL_KEYS.GPEN, MODEL_URL, onProgress);
    onProgress && onProgress({ stage: "compile" });
    const session = await createSession(bytes);
    releaseModelBytes(MODEL_KEYS.GPEN); // 75 MB of weights no longer duplicated
    onProgress && onProgress({ stage: "ready" });
    return session;
  })().catch((err) => {
    modelPromise = null;
    throw err;
  });
  return modelPromise;
}

/* ------------------------------------------------------------------ *
 * small canvas helpers
 * ------------------------------------------------------------------ */

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(canvas, readFrequently = false) {
  const ctx = canvas.getContext("2d", { willReadFrequently: readFrequently });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

function toCanvas(source) {
  if (source instanceof HTMLCanvasElement) return source;
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  const c = makeCanvas(w, h);
  ctx2d(c).drawImage(source, 0, 0);
  return c;
}

/** Halves the image repeatedly until one more halving would overshoot the
 *  target scale — avoids the aliasing a single big downscale produces. */
function prescale(source, scale) {
  let current = source;
  let factor = 1;
  while (scale * 2 < factor && current.width > 64 && current.height > 64) {
    const next = makeCanvas(current.width / 2, current.height / 2);
    ctx2d(next).drawImage(current, 0, 0, next.width, next.height);
    current = next;
    factor /= 2;
  }
  return { canvas: current, factor };
}

/** Progressive (max 2x per step) upscale — much crisper than one drawImage. */
function stepUpscale(source, target) {
  let current = source;
  while (current.width * 2 <= target) {
    const next = makeCanvas(current.width * 2, current.height * 2);
    ctx2d(next).drawImage(current, 0, 0, next.width, next.height);
    current = next;
  }
  if (current.width === target) return current;
  const out = makeCanvas(target, target);
  ctx2d(out).drawImage(current, 0, 0, target, target);
  return out;
}

/* ------------------------------------------------------------------ *
 * similarity transform (rotation + uniform scale + translation)
 * ------------------------------------------------------------------ */

/** Least-squares 2D similarity mapping `from` onto `to`. Uniform scale only,
 *  so facial proportions can never be stretched. */
function similarityTransform(from, to) {
  const n = from.length;
  let fx = 0,
    fy = 0,
    tx = 0,
    ty = 0;
  for (let i = 0; i < n; i++) {
    fx += from[i].x;
    fy += from[i].y;
    tx += to[i].x;
    ty += to[i].y;
  }
  fx /= n;
  fy /= n;
  tx /= n;
  ty /= n;

  let num = 0,
    den = 0,
    cross = 0;
  for (let i = 0; i < n; i++) {
    const ax = from[i].x - fx;
    const ay = from[i].y - fy;
    const bx = to[i].x - tx;
    const by = to[i].y - ty;
    num += ax * bx + ay * by;
    cross += ax * by - ay * bx;
    den += ax * ax + ay * ay;
  }
  if (den < 1e-6) return null;
  const a = num / den; // scale * cos
  const b = cross / den; // scale * sin
  return { a, b, e: tx - (a * fx - b * fy), f: ty - (b * fx + a * fy) };
}

function invertSimilarity(m) {
  const det = m.a * m.a + m.b * m.b;
  const a = m.a / det;
  const b = -m.b / det;
  return { a, b, e: -(a * m.e - b * m.f), f: -(b * m.e + a * m.f) };
}

const transformScale = (m) => Math.sqrt(m.a * m.a + m.b * m.b);

function applyTransform(m, p) {
  return { x: m.a * p.x - m.b * p.y + m.e, y: m.b * p.x + m.a * p.y + m.f };
}

const setTx = (ctx, m) => ctx.setTransform(m.a, m.b, -m.b, m.a, m.e, m.f);

/* ------------------------------------------------------------------ *
 * landmarks
 * ------------------------------------------------------------------ */

/** Real landmarks when the detector found them, otherwise a proportional
 *  estimate from the detected (or centred) face box. */
function fivePoints(face, w, h) {
  if (face?.landmarks) {
    const lm = face.landmarks;
    return {
      points: [lm.leftEye, lm.rightEye, lm.nose, lm.mouthLeft, lm.mouthRight],
      exact: true,
    };
  }
  const size = face?.faceHeight ? face.faceHeight : Math.min(w, h) * 0.55;
  const cx = face?.faceCenterX ?? w / 2;
  const cy = face?.faceCenterY ?? (face ? (face.headTopY + face.chinY) / 2 : h * 0.42);
  const s = size / 1.35; // template face height ≈ 1.35 * eye distance span
  return {
    points: [
      { x: cx - s * 0.23, y: cy - s * 0.12 },
      { x: cx + s * 0.23, y: cy - s * 0.12 },
      { x: cx, y: cy + s * 0.02 },
      { x: cx - s * 0.18, y: cy + s * 0.2 },
      { x: cx + s * 0.18, y: cy + s * 0.2 },
    ],
    exact: false,
  };
}

/* ------------------------------------------------------------------ *
 * model
 * ------------------------------------------------------------------ */

function runModel(ort, session, aligned) {
  const { data } = aligned.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, SIZE, SIZE);
  const area = SIZE * SIZE;
  const f = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    f[i] = data[i * 4] / 127.5 - 1;
    f[area + i] = data[i * 4 + 1] / 127.5 - 1;
    f[2 * area + i] = data[i * 4 + 2] / 127.5 - 1;
  }
  const inputName = session.inputNames.includes("input") ? "input" : session.inputNames[0];
  return session
    .run({ [inputName]: new ort.Tensor("float32", f, [1, 3, SIZE, SIZE]) })
    .then((out) => {
      const name = session.outputNames.includes("output") ? "output" : session.outputNames[0];
      const pred = out[name].data;
      const res = makeCanvas(SIZE, SIZE);
      const rctx = res.getContext("2d", { willReadFrequently: true });
      const id = rctx.createImageData(SIZE, SIZE);
      for (let i = 0; i < area; i++) {
        id.data[i * 4] = clamp255((pred[i] + 1) * 127.5);
        id.data[i * 4 + 1] = clamp255((pred[area + i] + 1) * 127.5);
        id.data[i * 4 + 2] = clamp255((pred[2 * area + i] + 1) * 127.5);
        id.data[i * 4 + 3] = 255;
      }
      rctx.putImageData(id, 0, 0);
      return res;
    });
}

/* ------------------------------------------------------------------ *
 * identity / geometry protection
 * ------------------------------------------------------------------ */

/** Mean colour of the central face area, sampled sparsely. */
function meanColour(imgData) {
  const d = imgData.data;
  const c = SIZE / 2;
  const rad = SIZE * 0.34;
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < SIZE; y += 2) {
    for (let x = 0; x < SIZE; x += 2) {
      const dx = x - c;
      const dy = y - c;
      if (dx * dx + dy * dy > rad * rad) continue;
      const i = (y * SIZE + x) * 4;
      sum[0] += d[i];
      sum[1] += d[i + 1];
      sum[2] += d[i + 2];
      n++;
    }
  }
  return n ? sum.map((v) => v / n) : null;
}

/** Gentle exposure/tone match so the restored face keeps the original skin
 *  tone. Clamped hard — this is a nudge, never a recolour. */
function matchTone(restored, aligned) {
  const rctx = restored.getContext("2d", { willReadFrequently: true });
  const r = rctx.getImageData(0, 0, SIZE, SIZE);
  const o = aligned.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, SIZE, SIZE);
  const mr = meanColour(r);
  const mo = meanColour(o);
  if (!mr || !mo) return restored;
  const shift = [0, 1, 2].map((ch) => Math.max(-14, Math.min(14, mo[ch] - mr[ch])));
  if (shift.every((s) => Math.abs(s) < 0.5)) return restored;
  const d = r.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp255(d[i] + shift[0]);
    d[i + 1] = clamp255(d[i + 1] + shift[1]);
    d[i + 2] = clamp255(d[i + 2] + shift[2]);
  }
  rctx.putImageData(r, 0, 0);
  return restored;
}

/** Dark-pixel centroid inside a window — a cheap stand-in for "where is the
 *  eye / mouth". Used to measure drift, never to paste pixels back. */
function darkCentroid(data, cx, cy, rx, ry) {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(SIZE - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(SIZE - 1, Math.ceil(cy + ry));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * SIZE + x) * 4;
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
    }
  }
  if (!n) return null;
  const mean = sum / n;
  let ax = 0,
    ay = 0,
    w = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * SIZE + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const weight = Math.max(0, mean - lum);
      ax += x * weight;
      ay += y * weight;
      w += weight;
    }
  }
  if (w <= 1e-3) return null;
  return { x: ax / w, y: ay / w };
}

/**
 * Measures how far the restoration moved the eyes and mouth in the aligned
 * crop. Returns a 0..1 confidence: 1 = identical geometry, lower = the model
 * drifted. The caller scales blend strength with it instead of throwing the
 * whole restoration away.
 */
function geometryConfidence(restored, aligned) {
  try {
    const rd = restored.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, SIZE, SIZE)
      .data;
    const od = aligned.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, SIZE, SIZE)
      .data;
    const zones = [
      { cx: TEMPLATE[0].x, cy: TEMPLATE[0].y, rx: SIZE * 0.075, ry: SIZE * 0.055 },
      { cx: TEMPLATE[1].x, cy: TEMPLATE[1].y, rx: SIZE * 0.075, ry: SIZE * 0.055 },
      {
        cx: (TEMPLATE[3].x + TEMPLATE[4].x) / 2,
        cy: (TEMPLATE[3].y + TEMPLATE[4].y) / 2,
        rx: SIZE * 0.1,
        ry: SIZE * 0.06,
      },
    ];
    let worst = 0;
    for (const z of zones) {
      const a = darkCentroid(rd, z.cx, z.cy, z.rx, z.ry);
      const b = darkCentroid(od, z.cx, z.cy, z.rx, z.ry);
      if (!a || !b) continue;
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
    }
    // < 3 px drift at 256 (~1% of face width) is normal restoration sharpening.
    const drift = Math.max(0, worst - 3);
    return { confidence: Math.max(0.4, 1 - drift / 12), drift: worst };
  } catch {
    return { confidence: 1, drift: 0 };
  }
}

/** True when the model returned something unusable (flat / blank output). */
function isDegenerate(canvas) {
  const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, SIZE, SIZE).data;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 64) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    sum += lum;
    sumSq += lum * lum;
    n++;
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return sd < 6;
}

/* ------------------------------------------------------------------ *
 * masking + finishing
 * ------------------------------------------------------------------ */

/** Soft face-shaped alpha in aligned space — no rectangle can ever show. */
function faceMask(size, alpha) {
  const m = makeCanvas(size, size);
  const ctx = m.getContext("2d");
  const s = size / SIZE;
  ctx.save();
  ctx.translate(SIZE * 0.5 * s, SIZE * 0.56 * s);
  ctx.scale(SIZE * 0.44 * s, SIZE * 0.52 * s);
  const g = ctx.createRadialGradient(0, 0, 0.15, 0, 0, 1);
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(0.62, `rgba(0,0,0,${alpha})`);
  g.addColorStop(0.86, `rgba(0,0,0,${alpha * 0.55})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  return m;
}

/**
 * Luminance-only unsharp mask.
 *
 * Only the high-frequency detail band is amplified: colour, skin tone,
 * exposure, brightness and contrast are mathematically untouched because the
 * band is zero-mean and the same delta is added to R, G and B. Halos are hard
 * clamped so the result reads as "in focus", never as "sharpened".
 */
function unsharpLuma(canvas, { amount, radius = 1, cap = 16, region = null }) {
  if (amount <= 0.01) return canvas;
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  const blur = makeCanvas(w, h);
  const bctx = blur.getContext("2d", { willReadFrequently: true });
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(canvas, 0, 0);
  bctx.filter = "none";
  const bd = bctx.getImageData(0, 0, w, h).data;

  const rd = region
    ? region.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data
    : null;

  for (let i = 0; i < d.length; i += 4) {
    let k = amount;
    if (rd) {
      const a = rd[i + 3] / 255;
      if (a <= 0.004) continue;
      k *= a;
    }
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const blum = 0.299 * bd[i] + 0.587 * bd[i + 1] + 0.114 * bd[i + 2];
    let delta = (lum - blum) * k;
    if (delta > cap) delta = cap;
    else if (delta < -cap) delta = -cap;
    d[i] = clamp255(d[i] + delta);
    d[i + 1] = clamp255(d[i + 1] + delta);
    d[i + 2] = clamp255(d[i + 2] + delta);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Multi-radius detail recovery: a wide pass rebuilds the structure blur eats
 * away, a mid pass restores facial definition and a fine pass brings back micro
 * texture (lashes, brows, pores). Every pass is a zero-mean high-pass band, so
 * brightness, contrast, exposure, lighting and skin tone stay exactly as they
 * were — only clarity changes.
 */
function recoverDetail(canvas, strength, region = null) {
  const s = Math.max(0, Math.min(1.2, strength));
  if (s <= 0.02) return canvas;
  unsharpLuma(canvas, { amount: 0.5 * s, radius: 2.2, cap: 13, region });
  unsharpLuma(canvas, { amount: 0.8 * s, radius: 1.1, cap: 15, region });
  unsharpLuma(canvas, { amount: 0.4 * s, radius: 0.6, cap: 9, region });
  return canvas;
}

/**
 * Cheap glasses probe on the aligned crop: spectacle frames and lens rims put
 * far more edge energy across the eye band than bare skin does on the cheeks.
 */
function detectGlasses(aligned) {
  try {
    const d = aligned
      .getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, SIZE, SIZE).data;
    const lum = (x, y) => {
      const i = (y * SIZE + x) * 4;
      return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    };
    const x0 = Math.round(SIZE * 0.18);
    const x1 = Math.round(SIZE * 0.82);
    const energy = (y0, y1) => {
      let s = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          s += Math.abs(lum(x, y) - lum(x, y + 1)) + Math.abs(lum(x, y) - lum(x + 1, y));
          n++;
        }
      }
      return n ? s / n : 0;
    };
    const eyeBand = energy(Math.round(SIZE * 0.38), Math.round(SIZE * 0.54));
    const cheekBand = energy(Math.round(SIZE * 0.6), Math.round(SIZE * 0.72));
    return eyeBand > 5 && eyeBand > cheekBand * 1.8;
  } catch {
    return false;
  }
}

/** Soft ellipse over both eyes (aligned template space) — used to give the
 *  lens / eye area an extra clarity pass without touching the rest of the face. */
function eyeRegionMask(size, alpha) {
  const m = makeCanvas(size, size);
  const ctx = m.getContext("2d");
  const s = size / SIZE;
  [TEMPLATE[0], TEMPLATE[1]].forEach((p) => {
    const cx = p.x * s;
    const cy = p.y * s;
    const rx = SIZE * 0.21 * s;
    const ry = SIZE * 0.14 * s;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, `rgba(0,0,0,${alpha})`);
    g.addColorStop(0.6, `rgba(0,0,0,${alpha})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
  return m;
}


/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

/**
 * Restores only the face of `source` and returns a new canvas at the same size.
 * @param {HTMLCanvasElement|HTMLImageElement} source
 * @param {{strength?: number, maskCanvas?: HTMLCanvasElement}} opts
 *   strength 0..1 — blend of the restored face (identity-safe, default 0.85)
 */
export async function restoreFace(source, opts = {}, onProgress) {
  const strength = Math.max(0.25, Math.min(1, opts.strength ?? 0.85));
  const { ort, session, backend } = await loadFaceModel(onProgress);
  const src = toCanvas(source);

  onProgress && onProgress({ stage: "detect" });
  let face = null;
  try {
    face = await detectFace(src, opts.maskCanvas || null, {});
  } catch {
    face = null;
  }
  const { points, exact } = fivePoints(face, src.width, src.height);

  // --- alignment: uniform scale + rotation onto the FFHQ template ---
  const forward = similarityTransform(points, TEMPLATE);
  if (!forward) {
    return { canvas: src, backend, faceFound: false, restored: false, reason: "no-transform" };
  }
  const scale = transformScale(forward);

  // Downscale in halving steps first when the face is much bigger than 256,
  // so the aligned crop is clean instead of aliased.
  const pre = prescale(src, scale);
  const alignedTx = {
    a: forward.a / pre.factor,
    b: forward.b / pre.factor,
    e: forward.e,
    f: forward.f,
  };

  const aligned = makeCanvas(SIZE, SIZE);
  const actx = ctx2d(aligned, true);
  // Edge-extend: draw a slightly blurred stretched backdrop first so any part
  // of the template that falls outside the photo is never black.
  actx.drawImage(pre.canvas, 0, 0, SIZE, SIZE);
  setTx(actx, alignedTx);
  actx.drawImage(pre.canvas, 0, 0);
  actx.setTransform(1, 0, 0, 1, 0, 0);

  onProgress && onProgress({ stage: "run" });
  const t0 = performance.now();
  let restored = await runModel(ort, session, aligned);
  const inferenceMs = performance.now() - t0;

  if (isDegenerate(restored)) {
    return { canvas: src, backend, faceFound: !!face, restored: false, reason: "model-failed" };
  }

  restored = matchTone(restored, aligned);
  const geo = geometryConfidence(restored, aligned);

  onProgress && onProgress({ stage: "composite" });

  // Restore at the face's real resolution: step-upscale the 256 result to the
  // size it will occupy, so the inverse warp is not a blurry stretch.
  const faceSizeInPhoto = SIZE / scale;
  const patchSize = Math.max(SIZE, Math.min(1024, Math.round(faceSizeInPhoto)));
  let patch = patchSize > SIZE ? stepUpscale(restored, patchSize) : restored;

  const upscaleRatio = patchSize / SIZE;
  // Detail recovery: always runs so soft / blurry uploads come back genuinely
  // crisp, and scales up with how far the 256 px patch had to be enlarged.
  // Luminance-band only: exposure, contrast, colour and lighting are unchanged.
  const detailStrength = Math.min(1, 0.5 + 0.32 * Math.log2(Math.max(1, upscaleRatio) + 1));
  recoverDetail(patch, detailStrength);

  // Glasses smudge the lens + eye area the most — give just that region an
  // extra, tightly masked clarity pass.
  if (detectGlasses(aligned)) {
    recoverDetail(patch, 0.6, eyeRegionMask(patchSize, 1));
  }


  // Blend strength: full when the geometry is untouched, gently reduced when
  // the model drifted, slightly lower when landmarks were only estimated.
  const blend = Math.max(0.3, Math.min(1, strength * geo.confidence * (exact ? 1 : 0.85)));

  const masked = makeCanvas(patchSize, patchSize);
  const mctx = ctx2d(masked);
  mctx.drawImage(patch, 0, 0, patchSize, patchSize);
  mctx.globalCompositeOperation = "destination-in";
  mctx.drawImage(faceMask(patchSize, blend), 0, 0);
  mctx.globalCompositeOperation = "source-over";

  // Inverse warp back onto the untouched original.
  const out = makeCanvas(src.width, src.height);
  const octx = ctx2d(out);
  octx.drawImage(src, 0, 0);
  const back = invertSimilarity(forward);
  const k = SIZE / patchSize;
  setTx(octx, {
    a: back.a * k,
    b: back.b * k,
    e: back.e,
    f: back.f,
  });
  octx.drawImage(masked, 0, 0);
  octx.setTransform(1, 0, 0, 1, 0, 0);

  const eyeCentre = applyTransform(back, TEMPLATE[0]);

  return {
    canvas: out,
    backend,
    inferenceMs,
    restored: true,
    faceFound: !!face,
    faceSource: exact ? face?.source || "onnx" : "estimated",
    landmarksExact: exact,
    blend,
    geometryDrift: geo.drift,
    geometryConfidence: geo.confidence,
    upscaleRatio,
    faceScale: scale,
    anchor: eyeCentre,
  };
}
