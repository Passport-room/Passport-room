// Studio photo editor — 10 tonal & detail adjustments applied to the cutout canvas.
// All sliders are in the range [-100, 100]. 0 = no change.

// Reduced to the 4 sliders that matter most for passport photos.
// Legacy saved keys are ignored on load — see loadEdits().
export const EDIT_KEYS = [
  "brightness", "contrast", "exposure", "highlights",
  "shadows", "clarity", "sharpness", "noise"
];

export const DEFAULT_EDITS = Object.fromEntries(EDIT_KEYS.map(k => [k, 0]));

const STORAGE_KEY = "makepics.edits.v1";

export function loadEdits(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_EDITS };
    const parsed = JSON.parse(raw);
    const out = { ...DEFAULT_EDITS };
    for (const k of EDIT_KEYS) if (typeof parsed[k] === "number") out[k] = clamp(parsed[k], -100, 100);
    return out;
  } catch { return { ...DEFAULT_EDITS }; }
}
export function saveEdits(edits){
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(edits)); } catch {}
}
export function isDefault(edits){
  return EDIT_KEYS.every(k => (edits[k] || 0) === 0);
}

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

/**
 * Apply edits to a source canvas, returning a new canvas of the same size.
 * Preserves the alpha channel (important — cutout has transparent background).
 */
export function applyEdits(sourceCanvas, edits){
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const octx = out.getContext("2d");
  octx.drawImage(sourceCanvas, 0, 0);
  if (isDefault(edits)) return out;

  const img = octx.getImageData(0, 0, w, h);
  const data = img.data;

  // Precompute a 256-entry lookup for tone ops (brightness/contrast/exposure/highlights/shadows/whites/blacks).
  const lut = buildToneLUT(edits);
  for (let i = 0; i < data.length; i += 4){
    if (data[i+3] === 0) continue;
    data[i]   = lut[data[i]];
    data[i+1] = lut[data[i+1]];
    data[i+2] = lut[data[i+2]];
  }

  // Noise reduction (box blur, small radius). Do it BEFORE sharpen/clarity so we sharpen the smoothed image.
  const noise = Number(edits.noise) || 0;
  if (noise > 0){
    const radius = Math.max(1, Math.round((noise / 100) * 3)); // 1..3 px
    boxBlurRGB(data, w, h, radius);
  }

  // Sharpness: unsharp mask via 3x3 kernel.
  const sharpness = Number(edits.sharpness) || 0;
  if (sharpness !== 0){
    const amount = sharpness / 100; // -1..1
    unsharpMask(data, w, h, amount, 1);
  }

  // Clarity: local mid-tone contrast (unsharp mask with larger radius, weighted by mid luminance).
  const clarity = Number(edits.clarity) || 0;
  if (clarity !== 0){
    const amount = clarity / 100; // -1..1
    unsharpMask(data, w, h, amount * 0.6, 4, true);
  }

  octx.putImageData(img, 0, 0);
  return out;
}

function buildToneLUT(e){
  const brightness = (e.brightness || 0) * 1.27;              // -127..127
  const exposure   = Math.pow(2, (e.exposure || 0) / 100);    // 0.5..2
  const contrast   = 1 + (e.contrast || 0) / 100;             // 0..2
  const highlights = (e.highlights || 0) / 100;               // -1..1
  const shadows    = (e.shadows    || 0) / 100;
  const whites     = (e.whites     || 0) / 100;
  const blacks     = (e.blacks     || 0) / 100;

  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++){
    let v = i / 255;
    // Exposure (linear multiply).
    v = v * exposure;
    // Brightness (additive).
    v = v + brightness / 255;
    // Contrast around mid-grey.
    v = (v - 0.5) * contrast + 0.5;

    // Region-based tone shaping. Weights are smooth bell curves.
    if (highlights !== 0){
      const w = smoothstep(0.5, 1.0, v);
      v += highlights * 0.35 * w;
    }
    if (shadows !== 0){
      const w = 1 - smoothstep(0.0, 0.5, v);
      v += shadows * 0.35 * w;
    }
    if (whites !== 0){
      const w = smoothstep(0.7, 1.05, v);
      v += whites * 0.4 * w;
    }
    if (blacks !== 0){
      const w = 1 - smoothstep(-0.05, 0.3, v);
      v += blacks * 0.4 * w;
    }

    lut[i] = Math.round(clamp(v, 0, 1) * 255);
  }
  return lut;
}

function smoothstep(a, b, x){
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// Simple separable box blur on RGB (skips alpha == 0 pixels for the read but writes all).
function boxBlurRGB(data, w, h, r){
  const tmp = new Uint8ClampedArray(data.length);
  const size = r * 2 + 1;
  // horizontal
  for (let y = 0; y < h; y++){
    let rr=0, gg=0, bb=0, cnt=0;
    for (let k = -r; k <= r; k++){
      const x = clamp(k, 0, w-1);
      const i = (y*w + x)*4;
      rr += data[i]; gg += data[i+1]; bb += data[i+2]; cnt++;
    }
    for (let x = 0; x < w; x++){
      const i = (y*w + x)*4;
      tmp[i] = rr/cnt; tmp[i+1] = gg/cnt; tmp[i+2] = bb/cnt; tmp[i+3] = data[i+3];
      const xAdd = clamp(x + r + 1, 0, w-1);
      const xSub = clamp(x - r, 0, w-1);
      const iA = (y*w + xAdd)*4, iS = (y*w + xSub)*4;
      rr += data[iA] - data[iS];
      gg += data[iA+1] - data[iS+1];
      bb += data[iA+2] - data[iS+2];
    }
  }
  // vertical
  for (let x = 0; x < w; x++){
    let rr=0, gg=0, bb=0, cnt=0;
    for (let k = -r; k <= r; k++){
      const y = clamp(k, 0, h-1);
      const i = (y*w + x)*4;
      rr += tmp[i]; gg += tmp[i+1]; bb += tmp[i+2]; cnt++;
    }
    for (let y = 0; y < h; y++){
      const i = (y*w + x)*4;
      data[i] = rr/cnt; data[i+1] = gg/cnt; data[i+2] = bb/cnt;
      const yAdd = clamp(y + r + 1, 0, h-1);
      const ySub = clamp(y - r, 0, h-1);
      const iA = (yAdd*w + x)*4, iS = (ySub*w + x)*4;
      rr += tmp[iA] - tmp[iS];
      gg += tmp[iA+1] - tmp[iS+1];
      bb += tmp[iA+2] - tmp[iS+2];
    }
  }
}

// Unsharp mask: result = original + amount * (original - blur(original))
// midtoneWeight=true weights the delta by a mid-luminance bell (used for "clarity").
function unsharpMask(data, w, h, amount, radius, midtoneWeight = false){
  const blurred = new Uint8ClampedArray(data.length);
  blurred.set(data);
  boxBlurRGB(blurred, w, h, radius);
  for (let i = 0; i < data.length; i += 4){
    if (data[i+3] === 0) continue;
    let weight = 1;
    if (midtoneWeight){
      const lum = (0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]) / 255;
      weight = 1 - Math.abs(lum - 0.5) * 2; // 1 at mid, 0 at extremes
      if (weight < 0) weight = 0;
    }
    const gain = amount * weight;
    data[i]   = clamp(data[i]   + (data[i]   - blurred[i])   * gain, 0, 255);
    data[i+1] = clamp(data[i+1] + (data[i+1] - blurred[i+1]) * gain, 0, 255);
    data[i+2] = clamp(data[i+2] + (data[i+2] - blurred[i+2]) * gain, 0, 255);
  }
}
