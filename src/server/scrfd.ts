// Minimal SCRFD (2.5G) face detector: single-scale-friendly, ONNX Runtime
// (CPU) inference producing bounding boxes + 5-point facial landmarks.
// Landmarks are what let us align a face crop the way GPEN/GFPGAN expect.

import * as ort from "onnxruntime-node";
import sharp from "sharp";

export type FaceDetection = {
  score: number;
  box: [number, number, number, number]; // x1, y1, x2, y2 in original image pixels
  landmarks: Array<[number, number]>; // 5 points: L-eye, R-eye, nose, L-mouth, R-mouth
};

const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32];
const NUM_ANCHORS = 2;

function generateAnchorCenters(featW: number, featH: number, stride: number): number[][] {
  const centers: number[][] = [];
  for (let y = 0; y < featH; y++) {
    for (let x = 0; x < featW; x++) {
      for (let a = 0; a < NUM_ANCHORS; a++) {
        centers.push([x * stride, y * stride]);
      }
    }
  }
  return centers;
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-9);
}

function nms(dets: FaceDetection[], thresh = 0.4): FaceDetection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: FaceDetection[] = [];
  for (const cand of sorted) {
    if (keep.every((k) => iou(k.box, cand.box) < thresh)) keep.push(cand);
  }
  return keep;
}

export class ScrfdDetector {
  private session: ort.InferenceSession;
  private static loggedOutputShapes = false;

  private constructor(session: ort.InferenceSession) {
    this.session = session;
  }

  static async load(modelPath: string): Promise<ScrfdDetector> {
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    return new ScrfdDetector(session);
  }

  /** Detects faces in an RGB image buffer (any size); returns detections in original-image pixel coordinates. */
  async detect(imageBuffer: Buffer, scoreThreshold = 0.5): Promise<FaceDetection[]> {
    const meta = await sharp(imageBuffer).metadata();
    const origW = meta.width ?? INPUT_SIZE;
    const origH = meta.height ?? INPUT_SIZE;
    const scale = Math.min(INPUT_SIZE / origW, INPUT_SIZE / origH);
    const newW = Math.round(origW * scale);
    const newH = Math.round(origH * scale);

    const { data } = await sharp(imageBuffer)
      .resize(newW, newH)
      .extend({
        top: 0,
        left: 0,
        bottom: INPUT_SIZE - newH,
        right: INPUT_SIZE - newW,
        background: { r: 0, g: 0, b: 0 },
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then((r) => r);

    // HWC uint8 RGB -> CHW float32, normalized (SCRFD: (px - 127.5) / 128)
    const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
    const plane = INPUT_SIZE * INPUT_SIZE;
    for (let i = 0; i < plane; i++) {
      const r = data[i * 3];
      const g = data[i * 3 + 1];
      const b = data[i * 3 + 2];
      chw[i] = (r - 127.5) / 128;
      chw[plane + i] = (g - 127.5) / 128;
      chw[2 * plane + i] = (b - 127.5) / 128;
    }

    const inputTensor = new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const inputName = this.session.inputNames[0];
    const outputs = await this.session.run({ [inputName]: inputTensor });

    if (!ScrfdDetector.loggedOutputShapes) {
      ScrfdDetector.loggedOutputShapes = true;
      console.log(
        "[scrfd] input names:",
        this.session.inputNames,
        "output names:",
        this.session.outputNames,
      );
      for (const name of this.session.outputNames) {
        console.log(`[scrfd] output "${name}" dims:`, outputs[name]?.dims);
      }
    }

    const dets: FaceDetection[] = [];
    let matchedAnyStride = false;
    for (const stride of STRIDES) {
      const featSize = INPUT_SIZE / stride;
      const scoreKey = this.session.outputNames.find((n) => n.includes(`score`) && n.includes(String(stride)));
      const bboxKey = this.session.outputNames.find((n) => n.includes(`bbox`) && n.includes(String(stride)));
      const kpsKey = this.session.outputNames.find((n) => n.includes(`kps`) && n.includes(String(stride)));
      if (!scoreKey || !bboxKey) continue;
      matchedAnyStride = true;

      const scores = outputs[scoreKey].data as Float32Array;
      const bboxes = outputs[bboxKey].data as Float32Array;
      const kpss = kpsKey ? (outputs[kpsKey].data as Float32Array) : undefined;
      const centers = generateAnchorCenters(featSize, featSize, stride);

      for (let i = 0; i < scores.length; i++) {
        const score = scores[i];
        if (score < scoreThreshold) continue;
        const [cx, cy] = centers[i];
        const x1 = cx - bboxes[i * 4] * stride;
        const y1 = cy - bboxes[i * 4 + 1] * stride;
        const x2 = cx + bboxes[i * 4 + 2] * stride;
        const y2 = cy + bboxes[i * 4 + 3] * stride;

        let landmarks: Array<[number, number]> = [];
        if (kpss) {
          landmarks = Array.from({ length: 5 }, (_, k) => {
            const lx = cx + kpss[i * 10 + k * 2] * stride;
            const ly = cy + kpss[i * 10 + k * 2 + 1] * stride;
            return [lx / scale, ly / scale] as [number, number];
          });
        }

        dets.push({
          score,
          box: [x1 / scale, y1 / scale, x2 / scale, y2 / scale],
          landmarks,
        });
      }
    }

    if (!matchedAnyStride) {
      console.error(
        "[scrfd] No output tensors matched expected score/bbox naming convention. " +
          "This model export likely uses different output names than assumed. " +
          "Actual output names:",
        this.session.outputNames,
      );
    }

    return nms(dets, 0.4);
  }

  /** Returns the single most prominent (largest, then highest-score) detected face, or null. */
  async detectPrimaryFace(imageBuffer: Buffer): Promise<FaceDetection | null> {
    const dets = await this.detect(imageBuffer);
    if (dets.length === 0) return null;
    dets.sort((a, b) => {
      const areaA = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]);
      const areaB = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
      return areaB - areaA;
    });
    return dets[0];
  }
}
