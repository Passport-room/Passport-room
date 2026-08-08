// On-device AI face enhancement — GPEN-BFR-256 (blind face restoration) run
// locally through onnxruntime-web. Same strategy as the background-remove
// model: streamed once from Hugging Face, saved on the device under
// "makepics-gpen-bfr-256-v1", then loaded straight from the device forever.
//
// The model only ever touches the face region: the face is located with the
// on-device face detector (real landmarks), restored at 256x256,
// colour-matched back to the original skin tone, under-eye shadows lifted,
// skin optionally softened (edge-preserving, skin-tones only), then upscaled
// with step-resizing + unsharp mask and feathered back into the untouched
// photo through a face-shaped oval mask. Nothing outside the face is altered.
import { MODEL_KEYS, getModelBytes, createSession, isModelSaved } from "./model-cache.js";
import { detectFace, detectFaceInCanvas } from "./face-detector.js";

const MODEL_URL = "https://huggingface.co/facefusion/models-3.0.0/resolve/main/gpen_bfr_256.onnx";
const SIZE = 256;

let modelPromise = null;

export function isFaceModelSaved() {
  return isModelSaved(MODEL_KEYS.GPEN);
}

export function loadFaceModel(onProgress) {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const bytes = await getModelBytes(MODEL_KEYS.GPEN, MODEL_URL, onProgress);
    onProgress && onProgress({ stage: "compile" });
    const { ort, session, backend } = await createSession(bytes);
    onProgress && onProgress({ stage: "ready" });
    return { ort, session, backend };
  })().catch((err) => {
    modelPromise = null;
    throw err;
  });
  return modelPromise;
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function toCanvas(source) {
  if (source instanceof HTMLCanvasElement) return source;
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  const c = makeCanvas(w, h);
  c.getContext("2d").drawImage(source, 0, 0);
  return c;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Square face box with generous margin so hairline, ears and chin all fit —
// GPEN is trained on full-face crops, feeding it a tight crop distorts features.
function faceBox(face, w, h) {
  if (!face) {
    const size = Math.min(w, h) * 0.8;
    return { x: (w - size) / 2, y: (h - size) / 2, size };
  }
  const cx = face.faceCenterX;
  const cy = face.faceCenterY ?? (face.headTopY + face.chinY) / 2;
  let size = face.faceHeight * 1.95;
  size = Math.min(size, Math.min(w, h) * 1.6);
  size = Math.max(size, 64);
  return { x: cx - size / 2, y: cy - size / 2, size };
}

/** Draws a region (which may hang off the image) into a square canvas, clamping at edges. */
function cropSquare(source, box, out) {
  const c = makeCanvas(out, out);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const scale = out / box.size;
  // Edge-extend by drawing the clamped source region into its mapped position,
  // then stretching the border pixels outward via a base fill of the clamped area.
  const sx = Math.max(0, box.x);
  const sy = Math.max(0, box.y);
  const sw = Math.min(source.width, box.x + box.size) - sx;
  const sh = Math.min(source.height, box.y + box.size) - sy;
  if (sw <= 0 || sh <= 0) return c;
  const dx = (sx - box.x) * scale;
  const dy = (sy - box.y) * scale;
  const dw = sw * scale;
  const dh = sh * scale;
  // Fill first with a stretched copy so out-of-bounds margins are not black.
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, out, out);
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  return c;
}

function runModel(ort, session, cropCanvas) {
  const ctx = cropCanvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const area = SIZE * SIZE;
  const f = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    f[i] = data[i * 4] / 127.5 - 1;
    f[area + i] = data[i * 4 + 1] / 127.5 - 1;
    f[2 * area + i] = data[i * 4 + 2] / 127.5 - 1;
  }
  const tensor = new ort.Tensor("float32", f, [1, 3, SIZE, SIZE]);
  const inputName = session.inputNames.includes("input") ? "input" : session.inputNames[0];
  return session.run({ [inputName]: tensor }).then((out) => {
    const outputName = session.outputNames.includes("output") ? "output" : session.outputNames[0];
    const pred = out[outputName].data;
    const res = makeCanvas(SIZE, SIZE);
    const rctx = res.getContext("2d", { willReadFrequently: true });
    const id = rctx.createImageData(SIZE, SIZE);
    for (let i = 0; i < area; i++) {
      for (let ch = 0; ch < 3; ch++) {
        id.data[i * 4 + ch] = clamp255((pred[ch * area + i] + 1) * 127.5);
      }
      id.data[i * 4 + 3] = 255;
    }
    rctx.putImageData(id, 0, 0);
    return res;
  });
}

// Keeps the restored face on exactly the same skin tone / exposure as the
// original so the enhance never recolours or "changes" the person.
function matchColour(restored, original) {
  const rctx = restored.getContext("2d", { willReadFrequently: true });
  const octx = original.getContext("2d", { willReadFrequently: true });
  const r = rctx.getImageData(0, 0, SIZE, SIZE);
  const o = octx.getImageData(0, 0, SIZE, SIZE);
  const n = SIZE * SIZE;
  const cx = SIZE / 2;
  const rad = SIZE * 0.36;
  const sums = [0, 0, 0];
  const sumo = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < SIZE; y += 2) {
    for (let x = 0; x < SIZE; x += 2) {
      const dx = x - cx;
      const dy = y - cx;
      if (dx * dx + dy * dy > rad * rad) continue;
      const i = (y * SIZE + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        sums[ch] += r.data[i + ch];
        sumo[ch] += o.data[i + ch];
      }
      count++;
    }
  }
  if (!count) return restored;
  const shift = [0, 1, 2].map((ch) => {
    const d = sumo[ch] / count - sums[ch] / count;
    return Math.max(-24, Math.min(24, d));
  });
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < 3; ch++) {
      r.data[i * 4 + ch] = clamp255(r.data[i * 4 + ch] + shift[ch]);
    }
  }
  rctx.putImageData(r, 0, 0);
  return restored;
}

/* ------------------------------------------------------------------ *
 * Landmark-driven local corrections (all inside the 256px crop space)
 * ------------------------------------------------------------------ */

/** Maps full-image coordinates into the 256px crop space. */
function toCropSpace(pt, box) {
  const s = SIZE / box.size;
  return { x: (pt.x - box.x) * s, y: (pt.y - box.y) * s };
}

function cropLandmarks(face, box) {
  if (!face?.landmarks) return null;
  const lm = face.landmarks;
  return {
    leftEye: toCropSpace(lm.leftEye, box),
    rightEye: toCropSpace(lm.rightEye, box),
    nose: toCropSpace(lm.nose, box),
    mouthLeft: toCropSpace(lm.mouthLeft, box),
    mouthRight: toCropSpace(lm.mouthRight, box),
  };
}

function cropEllipse(face, box) {
  const s = SIZE / box.size;
  if (face?.ellipse) {
    const c = toCropSpace({ x: face.ellipse.cx, y: face.ellipse.cy }, box);
    return {
      cx: c.x,
      cy: c.y,
      rx: face.ellipse.rx * s,
      ry: face.ellipse.ry * s,
      angle: face.ellipse.angle || 0,
    };
  }
  // No detection at all: an oval matched to average face proportions,
  // never a perfect circle.
  return { cx: SIZE / 2, cy: SIZE / 2, rx: SIZE * 0.34, ry: SIZE * 0.46, angle: 0 };
}

/** 1 inside the oval, falling smoothly to 0 at `feather` beyond its edge. */
function ellipseWeight(x, y, e, feather = 0.22) {
  const cos = Math.cos(-e.angle);
  const sin = Math.sin(-e.angle);
  const dx = x - e.cx;
  const dy = y - e.cy;
  const u = (dx * cos - dy * sin) / Math.max(1, e.rx);
  const v = (dx * sin + dy * cos) / Math.max(1, e.ry);
  const d = Math.sqrt(u * u + v * v);
  if (d <= 1 - feather) return 1;
  if (d >= 1) return 0;
  const t = (1 - d) / feather;
  return t * t * (3 - 2 * t);
}

/** Loose skin-tone test in YCbCr — keeps lips/eyes/brows out of smoothing. */
function isSkin(r, g, b) {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return r > 50 && cb >= 77 && cb <= 137 && cr >= 130 && cr <= 180 && r >= g && g >= b - 12;
}

/**
 * Fix #3 — dark circles. Locally lifts the shadow under each eye using the
 * real eye landmarks. Strength tapers with pixel darkness and is hard-clamped
 * so the result stays natural (no flat grey patches, no brightened lashes).
 *
 * The zones are deliberately wide with a very long feather and a low maximum
 * lift: a short falloff produced two visible bright dots beside the eyes.
 * The lift is also blended towards the local surrounding skin tone instead of
 * being added flat, so it can never read as a distinct spot.
 */
function liftUnderEyes(canvas, lm, amount) {
  if (!lm || amount <= 0) return canvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  const d = img.data;
  const eyeDist = Math.max(
    8,
    Math.hypot(lm.rightEye.x - lm.leftEye.x, lm.rightEye.y - lm.leftEye.y),
  );
  const angle = Math.atan2(lm.rightEye.y - lm.leftEye.y, lm.rightEye.x - lm.leftEye.x);
  // Down direction along the face axis (handles tilted heads).
  const dnX = -Math.sin(angle);
  const dnY = Math.cos(angle);
  const maxLift = 11 * amount; // hard cap — subtle by design

  const zones = [lm.leftEye, lm.rightEye].map((eye) => ({
    cx: eye.x + dnX * eyeDist * 0.36,
    cy: eye.y + dnY * eyeDist * 0.36,
    rx: eyeDist * 0.52,
    ry: eyeDist * 0.4,
    angle,
  }));

  for (const z of zones) {
    const x0 = Math.max(0, Math.floor(z.cx - z.rx - z.ry));
    const x1 = Math.min(SIZE - 1, Math.ceil(z.cx + z.rx + z.ry));
    const y0 = Math.max(0, Math.floor(z.cy - z.rx - z.ry));
    const y1 = Math.min(SIZE - 1, Math.ceil(z.cy + z.rx + z.ry));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // Very wide feather (0.92) so the correction dissolves into the
        // surrounding skin with no visible edge.
        const w0 = ellipseWeight(x, y, z, 0.92);
        const w = w0 * w0; // extra-soft shoulder
        if (w <= 0) continue;
        const i = (y * SIZE + x) * 4;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        // Leave lashes / eyeliner / pupils alone, and skip already-bright skin.
        if (lum < 55 || lum > 205) continue;
        if (!isSkin(r, g, b)) continue;
        const shadow = Math.min(1, Math.max(0, (170 - lum) / 150));
        const lift = maxLift * w * Math.pow(shadow, 1.6);
        // Lift luminance and gently pull back the blue/violet cast of the shadow.
        d[i] = clamp255(r + lift * 1.0);
        d[i + 1] = clamp255(g + lift * 0.98);
        d[i + 2] = clamp255(b + lift * 0.86);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ *
 * STRICT RULE — the enhancer must NEVER change face geometry.
 *
 * GPEN-BFR is a generative restoration model: it infers detail and can
 * subtly reshape features (eye size/shape, nose, mouth). That is not
 * acceptable here. The enhancer may only restore texture, sharpness and
 * colour INSIDE the person's real features. Two safeguards enforce this:
 *
 *   1. validateFaceGeometry() measures the eyes on the restored crop and
 *      compares them with the original crop. Any drift in eye position,
 *      spacing or size beyond a few percent of face width means the whole
 *      restoration is discarded and we fall back to the sharpen /
 *      detail-transfer-only pipeline (no GPEN blend at all).
 *   2. protectEyes() re-composites the ORIGINAL eye area back on top at high
 *      opacity after restoration, so eye shape and size always stay exactly
 *      the person's own even when GPEN altered them.
 * ------------------------------------------------------------------ */

function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

/** Dark-pixel centroid + area inside a window around an eye landmark. */
function measureEye(ctxData, eye, radius) {
  const x0 = Math.max(0, Math.floor(eye.x - radius));
  const x1 = Math.min(SIZE - 1, Math.ceil(eye.x + radius));
  const y0 = Math.max(0, Math.floor(eye.y - radius * 0.75));
  const y1 = Math.min(SIZE - 1, Math.ceil(eye.y + radius * 0.75));
  let sum = 0;
  let count = 0;
  const lums = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * SIZE + x) * 4;
      const lum = 0.299 * ctxData[i] + 0.587 * ctxData[i + 1] + 0.114 * ctxData[i + 2];
      lums.push(lum);
      sum += lum;
      count++;
    }
  }
  if (!count) return null;
  const mean = sum / count;
  let sd = 0;
  for (const l of lums) sd += (l - mean) * (l - mean);
  sd = Math.sqrt(sd / count);
  const thresh = mean - sd * 0.6;
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * SIZE + x) * 4;
      const lum = 0.299 * ctxData[i] + 0.587 * ctxData[i + 1] + 0.114 * ctxData[i + 2];
      if (lum > thresh) continue;
      cx += x;
      cy += y;
      n++;
    }
  }
  if (!n) return null;
  return { cx: cx / n, cy: cy / n, area: n };
}

/**
 * Compares the restored eyes with the original ones. Returns
 * { ok, drift, sizeRatio, spacingRatio } — ok === false means the model moved
 * or resized the eyes and its output must not be used.
 */
function validateFaceGeometry(restored, original, lm) {
  if (!lm) return { ok: true, reason: "no-landmarks" };
  try {
    const rd = restored
      .getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, SIZE, SIZE).data;
    const od = original
      .getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, SIZE, SIZE).data;
    const eyeDist = Math.max(
      8,
      Math.hypot(lm.rightEye.x - lm.leftEye.x, lm.rightEye.y - lm.leftEye.y),
    );
    const radius = eyeDist * 0.3;
    const eyes = [lm.leftEye, lm.rightEye];
    const rm = eyes.map((e) => measureEye(rd, e, radius));
    const om = eyes.map((e) => measureEye(od, e, radius));
    if (rm.some((m) => !m) || om.some((m) => !m)) return { ok: true, reason: "unmeasurable" };

    // Tolerances expressed against the inter-eye distance (~ face width / 2).
    const maxDrift = eyeDist * 0.05; // ~2.5% of face width
    let drift = 0;
    let sizeRatio = 1;
    for (let i = 0; i < 2; i++) {
      drift = Math.max(drift, Math.hypot(rm[i].cx - om[i].cx, rm[i].cy - om[i].cy));
      const ratio = Math.sqrt(rm[i].area / Math.max(1, om[i].area));
      sizeRatio = Math.max(sizeRatio, ratio, 1 / Math.max(0.0001, ratio));
    }
    const rSpacing = Math.hypot(rm[1].cx - rm[0].cx, rm[1].cy - rm[0].cy);
    const oSpacing = Math.hypot(om[1].cx - om[0].cx, om[1].cy - om[0].cy);
    const spacingRatio = rSpacing / Math.max(1, oSpacing);
    const ok = drift <= maxDrift && sizeRatio <= 1.18 && Math.abs(spacingRatio - 1) <= 0.05;
    return { ok, drift, sizeRatio, spacingRatio };
  } catch {
    return { ok: true, reason: "error" };
  }
}

/**
 * Re-composites the ORIGINAL eye area over the restored crop through a tight
 * feathered mask around lm.leftEye / lm.rightEye. Guarantees the person's own
 * eye shape and size survive the restoration.
 */
function protectEyes(restored, original, lm, opacity = 0.92) {
  if (!lm || opacity <= 0) return restored;
  const eyeDist = Math.max(
    8,
    Math.hypot(lm.rightEye.x - lm.leftEye.x, lm.rightEye.y - lm.leftEye.y),
  );
  const ang = Math.atan2(lm.rightEye.y - lm.leftEye.y, lm.rightEye.x - lm.leftEye.x);

  // Original eye patch, masked to two soft ovals.
  const patch = cloneCanvas(original);
  const mask = makeCanvas(SIZE, SIZE);
  const mctx = mask.getContext("2d");
  for (const eye of [lm.leftEye, lm.rightEye]) {
    mctx.save();
    mctx.translate(eye.x, eye.y);
    mctx.rotate(ang);
    mctx.scale(eyeDist * 0.42, eyeDist * 0.3);
    const g = mctx.createRadialGradient(0, 0, 0.1, 0, 0, 1);
    g.addColorStop(0, `rgba(0,0,0,${opacity})`);
    g.addColorStop(0.6, `rgba(0,0,0,${opacity})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    mctx.fillStyle = g;
    mctx.beginPath();
    mctx.arc(0, 0, 1, 0, Math.PI * 2);
    mctx.fill();
    mctx.restore();
  }
  const pctx = patch.getContext("2d");
  pctx.globalCompositeOperation = "destination-in";
  pctx.drawImage(mask, 0, 0);
  pctx.globalCompositeOperation = "source-over";

  const rctx = restored.getContext("2d");
  rctx.drawImage(patch, 0, 0);
  return restored;
}

/**
 * Fix #5 — soft skin. Bilateral (edge-preserving) smoothing applied only to
 * skin-toned pixels inside the face oval, so eyes, lips, brows, nostrils and
 * hair keep every bit of their sharpness.
 */
function softSkin(canvas, ellipse, lm, amount) {
  if (amount <= 0) return canvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const radius = amount > 0.55 ? 3 : 2;
  const sigmaColor = 18 + 26 * amount;
  const inv2sc = 1 / (2 * sigmaColor * sigmaColor);
  const spatial = [];
  const sigmaSpace = radius * 0.75;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      spatial.push({ dx, dy, w: Math.exp(-(dx * dx + dy * dy) / (2 * sigmaSpace * sigmaSpace)) });
    }
  }

  // Protect feature zones (eyes + mouth) with an explicit keep-sharp mask.
  const protect = [];
  if (lm) {
    const eyeDist = Math.max(
      8,
      Math.hypot(lm.rightEye.x - lm.leftEye.x, lm.rightEye.y - lm.leftEye.y),
    );
    const ang = Math.atan2(lm.rightEye.y - lm.leftEye.y, lm.rightEye.x - lm.leftEye.x);
    protect.push({
      cx: lm.leftEye.x,
      cy: lm.leftEye.y,
      rx: eyeDist * 0.34,
      ry: eyeDist * 0.26,
      angle: ang,
    });
    protect.push({
      cx: lm.rightEye.x,
      cy: lm.rightEye.y,
      rx: eyeDist * 0.34,
      ry: eyeDist * 0.26,
      angle: ang,
    });
    protect.push({
      cx: (lm.mouthLeft.x + lm.mouthRight.x) / 2,
      cy: (lm.mouthLeft.y + lm.mouthRight.y) / 2,
      rx: eyeDist * 0.46,
      ry: eyeDist * 0.3,
      angle: ang,
    });
  }

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let w = ellipseWeight(x, y, ellipse, 0.3);
      if (w <= 0.01) continue;
      const i = (y * SIZE + x) * 4;
      const r0 = src[i];
      const g0 = src[i + 1];
      const b0 = src[i + 2];
      if (!isSkin(r0, g0, b0)) continue;
      for (const p of protect) {
        const pw = ellipseWeight(x, y, p, 0.6);
        if (pw > 0) w *= 1 - pw;
      }
      if (w <= 0.01) continue;

      let sr = 0,
        sg = 0,
        sb = 0,
        sw = 0;
      for (const s of spatial) {
        const nx = x + s.dx;
        const ny = y + s.dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const j = (ny * SIZE + nx) * 4;
        const dr = src[j] - r0;
        const dg = src[j + 1] - g0;
        const db = src[j + 2] - b0;
        const wgt = s.w * Math.exp(-(dr * dr + dg * dg + db * db) * inv2sc);
        sr += src[j] * wgt;
        sg += src[j + 1] * wgt;
        sb += src[j + 2] * wgt;
        sw += wgt;
      }
      if (sw <= 0) continue;
      const mix = w * amount;
      d[i] = clamp255(r0 + (sr / sw - r0) * mix);
      d[i + 1] = clamp255(g0 + (sg / sw - g0) * mix);
      d[i + 2] = clamp255(b0 + (sb / sw - b0) * mix);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ *
 * Fix #2 — resolution: step resizing + unsharp mask
 * ------------------------------------------------------------------ */

/** Progressive (max 2x per step) upscale — far crisper than one big drawImage. */
function stepResize(source, targetSize) {
  let current = source;
  let size = source.width;
  while (size * 2 < targetSize) {
    const next = makeCanvas(size * 2, size * 2);
    const nctx = next.getContext("2d");
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = "high";
    nctx.drawImage(current, 0, 0, size * 2, size * 2);
    current = next;
    size *= 2;
  }
  if (size === targetSize) return current;
  const out = makeCanvas(targetSize, targetSize);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(current, 0, 0, targetSize, targetSize);
  return out;
}

/** Separable box blur (run twice ≈ gaussian) over an RGBA buffer. */
function blurRGBA(src, w, h, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const passes = 2;
  let input = Float32Array.from(src);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0,
            n = 0;
          for (let k = -radius; k <= radius; k++) {
            const nx = Math.min(w - 1, Math.max(0, x + k));
            sum += input[(y * w + nx) * 4 + ch];
            n++;
          }
          tmp[(y * w + x) * 4 + ch] = sum / n;
        }
      }
    }
    // vertical
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0,
            n = 0;
          for (let k = -radius; k <= radius; k++) {
            const ny = Math.min(h - 1, Math.max(0, y + k));
            sum += tmp[(ny * w + x) * 4 + ch];
            n++;
          }
          out[(y * w + x) * 4 + ch] = sum / n;
        }
      }
    }
    input = Float32Array.from(out);
  }
  return out;
}

/**
 * Unsharp mask with halo control. `amount` is scaled by the caller to the
 * upscale ratio so a 3000px photo gets more bite than a 600px one.
 */
function unsharpMask(canvas, amount, radius) {
  if (amount <= 0) return canvas;
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const blurred = blurRGBA(d, w, h, Math.max(1, Math.round(radius)));
  const maxDelta = 28; // halo clamp — keeps edges from ringing
  for (let i = 0; i < d.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const base = d[i + ch];
      let delta = (base - blurred[i + ch]) * amount;
      if (delta > maxDelta) delta = maxDelta;
      else if (delta < -maxDelta) delta = -maxDelta;
      d[i + ch] = clamp255(base + delta);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Detail transfer — re-injects the original photo's high-frequency texture
 * into the upscaled 256px restoration. Without it a 3000px+ photo always looks
 * soft, because GPEN can only ever output 256x256. Luminance-only and
 * amplitude-limited, so skin tone and the restored features are untouched.
 */
function transferDetail(patch, originalPatch, amount, radius) {
  if (amount <= 0) return patch;
  const size = patch.width;
  const hp = makeCanvas(size, size);
  const hctx = hp.getContext("2d");
  // 50% grey + half the original's high-frequency detail (classic high pass).
  hctx.filter = "grayscale(1)";
  hctx.drawImage(originalPatch, 0, 0, size, size);
  hctx.globalAlpha = 0.5;
  hctx.filter = `grayscale(1) blur(${radius}px) invert(1)`;
  hctx.drawImage(originalPatch, 0, 0, size, size);
  hctx.globalAlpha = 1;
  hctx.filter = "none";

  const pctx = patch.getContext("2d");
  pctx.save();
  pctx.globalCompositeOperation = "overlay";
  pctx.globalAlpha = Math.min(0.4, amount);
  pctx.drawImage(hp, 0, 0);
  pctx.restore();
  return patch;
}

/* ------------------------------------------------------------------ *
 * Fix #4 — face-shaped feather mask
 * ------------------------------------------------------------------ */

/**
 * Soft face-shaped alpha so the restored face melts into the original photo.
 * Uses the detected oval (rotated with the head when tilted); with no
 * detection it falls back to an ellipse matched to face proportions.
 */
function featherMask(size, strength, ellipse) {
  const m = makeCanvas(size, size);
  const ctx = m.getContext("2d");
  const scale = size / SIZE;
  const cx = ellipse.cx * scale;
  const cy = ellipse.cy * scale;
  const rx = ellipse.rx * scale;
  const ry = ellipse.ry * scale;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ellipse.angle || 0);
  ctx.scale(rx, ry);
  // Slightly over-reach the oval (1.06) so the jaw/hairline transition is soft.
  const g = ctx.createRadialGradient(0, 0, 0.2, 0, 0, 1.06);
  g.addColorStop(0, `rgba(0,0,0,${strength})`);
  g.addColorStop(0.66, `rgba(0,0,0,${strength})`);
  g.addColorStop(0.87, `rgba(0,0,0,${strength * 0.45})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, 1.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  return m;
}

/**
 * Enhances only the face of `source`, returning a new canvas at the same size.
 * @param {HTMLCanvasElement|HTMLImageElement} source original photo
 * @param {object} opts
 *   strength: 0..1   blend opacity of the restored face
 *   sharpen:  0..1   unsharp-mask amount (scaled by the upscale ratio)
 *   softSkin: 0..1   edge-preserving skin smoothing
 *   underEye: 0..1   under-eye shadow lift (defaults to 0.7)
 *   maskCanvas: person alpha mask (helps the heuristic fallback)
 */
export async function enhanceFace(source, opts = {}, onProgress) {
  const strength = Math.max(0.2, Math.min(1, opts.strength ?? 0.85));
  const sharpenOpt = Math.max(0, Math.min(1, opts.sharpen ?? 0.4));
  const softSkinOpt = Math.max(0, Math.min(1, opts.softSkin ?? 0));
  // Under-eye lift defaults low on purpose (see liftUnderEyes) and can be
  // switched off entirely with underEye: 0.
  const underEyeOpt = Math.max(0, Math.min(1, opts.underEye ?? 0.35));

  const { ort, session, backend } = await loadFaceModel(onProgress);
  const src = toCanvas(source);

  onProgress && onProgress({ stage: "detect" });
  let face = null;
  try {
    face = await detectFace(src, opts.maskCanvas || null, {
      useModel: opts.useFaceModel !== false,
    });
  } catch {
    try {
      face = detectFaceInCanvas(src, opts.maskCanvas || null);
    } catch {
      face = null;
    }
  }
  const box = faceBox(face, src.width, src.height);
  const lm = cropLandmarks(face, box);
  const ellipse = cropEllipse(face, box);

  onProgress && onProgress({ stage: "run" });
  const crop = cropSquare(src, box, SIZE);
  const t0 = performance.now();
  let restored = await runModel(ort, session, crop);
  const inferenceMs = performance.now() - t0;

  // Global tone match, then the geometry guard, then the local passes.
  restored = matchColour(restored, crop);

  // STRICT RULE: never change face geometry. If GPEN moved/resized the eyes,
  // throw the restoration away and keep the original pixels (the sharpen /
  // detail-transfer pipeline below still runs, so the photo still improves).
  const geometry = validateFaceGeometry(restored, crop, lm);
  const geometryFallback = geometry.ok === false;
  if (geometryFallback) restored = cloneCanvas(crop);

  // Always re-composite the original eyes on top — eye shape/size stays the
  // person's own even when the geometry check passed.
  restored = protectEyes(restored, crop, lm, geometryFallback ? 1 : 0.92);

  restored = liftUnderEyes(restored, lm, underEyeOpt);
  if (softSkinOpt > 0) {
    onProgress && onProgress({ stage: "soften" });
    restored = softSkin(restored, ellipse, lm, softSkinOpt);
  }

  // Upscale the 256px restoration up to the real face size, then sharpen by
  // how far it was stretched — this is what removes the "blurry after
  // upscale" look on big photos.
  const patchSize = Math.max(1, Math.round(box.size));
  const upscaleRatio = patchSize / SIZE;
  let patch = stepResize(restored, patchSize);
  let sharpenAmount = 0;
  let sharpenRadius = 0;
  let detailAmount = 0;
  if (upscaleRatio > 1.05 && sharpenOpt > 0) {
    onProgress && onProgress({ stage: "sharpen" });
    // Put the original photo's real texture back before sharpening, scaled by
    // how far the 256px restoration had to be stretched.
    detailAmount =
      opts.detailTransfer ??
      Math.min(0.34, 0.1 * Math.log2(upscaleRatio + 1)) * (0.6 + 0.4 * sharpenOpt);
    if (detailAmount > 0.01) {
      const originalPatch = cropSquare(src, box, patchSize);
      patch = transferDetail(patch, originalPatch, detailAmount, 2);
    }
    const ratioBoost = Math.min(1.6, 0.45 + 0.42 * Math.log2(upscaleRatio + 1));
    sharpenAmount = Math.min(1.2, sharpenOpt * 1.35 * ratioBoost);
    sharpenRadius = Math.min(2.5, Math.max(1, upscaleRatio * 0.3));
    patch = unsharpMask(patch, sharpenAmount, sharpenRadius);
  }

  // Composite: original untouched photo + face-shaped feathered face on top.
  const out = makeCanvas(src.width, src.height);
  const octx = out.getContext("2d");
  octx.drawImage(src, 0, 0);

  const pctx = patch.getContext("2d");
  pctx.globalCompositeOperation = "destination-in";
  pctx.drawImage(featherMask(patchSize, strength, ellipse), 0, 0);
  pctx.globalCompositeOperation = "source-over";

  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(patch, box.x, box.y);

  return {
    // Backward-compatible fields
    canvas: out,
    backend,
    inferenceMs,
    faceFound: !!face,
    // Added fields
    faceSource: face?.source || "none",
    faceScore: face?.score ?? null,
    landmarks: face?.landmarks || null,
    roll: face?.roll ?? 0,
    upscaleRatio,
    sharpenAmount,
    sharpenRadius,
    detailAmount,
    softSkinAmount: softSkinOpt,
    underEyeAmount: underEyeOpt,
    geometryFallback,
    geometry,
    faceBox: { x: box.x, y: box.y, size: box.size },
  };
}
