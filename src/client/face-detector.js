// Pixel-level Cascade Face & Head Detector
// Detects exact head top, chin, face height, and horizontal face center for ideal passport photo cropping.

export function detectFaceInCanvas(sourceCanvas, maskCanvas) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;

  if (!w || !h) {
    return null;
  }

  // Sample image for fast face feature detection
  const sampleW = 200;
  const sampleH = Math.max(1, Math.round((h / w) * sampleW));

  const temp = document.createElement("canvas");
  temp.width = sampleW;
  temp.height = sampleH;
  const ctx = temp.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, sampleW, sampleH);
  const imgData = ctx.getImageData(0, 0, sampleW, sampleH);
  const data = imgData.data;

  // Mask alpha data if available
  let maskData = null;
  if (maskCanvas) {
    const mtemp = document.createElement("canvas");
    mtemp.width = sampleW;
    mtemp.height = sampleH;
    const mctx = mtemp.getContext("2d", { willReadFrequently: true });
    mctx.drawImage(maskCanvas, 0, 0, sampleW, sampleH);
    maskData = mctx.getImageData(0, 0, sampleW, sampleH).data;
  }

  // 1. Detect head top from alpha mask or non-transparent silhouette
  let headTopSampleY = -1;
  let headBottomSampleY = -1;
  let minSampleX = sampleW,
    maxSampleX = 0;

  for (let y = 0; y < sampleH; y++) {
    let rowAlphaCount = 0;
    for (let x = 0; x < sampleW; x++) {
      const idx = (y * sampleW + x) * 4;
      const alpha = maskData ? maskData[idx + 3] : data[idx + 3];
      if (alpha > 15) {
        rowAlphaCount++;
        if (x < minSampleX) minSampleX = x;
        if (x > maxSampleX) maxSampleX = x;
      }
    }
    if (rowAlphaCount >= 2) {
      if (headTopSampleY === -1) headTopSampleY = y;
      headBottomSampleY = y;
    }
  }

  if (headTopSampleY === -1) {
    return null;
  }

  const cutoutSampleH = headBottomSampleY - headTopSampleY + 1;

  // 2. Measure head width & center in the upper 30% section of person cutout
  const upperYEnd = Math.min(
    sampleH - 1,
    Math.round(headTopSampleY + cutoutSampleH * 0.35),
  );
  let headMinX = sampleW,
    headMaxX = 0;
  let headXSum = 0,
    headXCount = 0;

  for (let y = headTopSampleY; y <= upperYEnd; y++) {
    for (let x = 0; x < sampleW; x++) {
      const idx = (y * sampleW + x) * 4;
      const alpha = maskData ? maskData[idx + 3] : data[idx + 3];
      if (alpha > 80) {
        if (x < headMinX) headMinX = x;
        if (x > headMaxX) headMaxX = x;
        headXSum += x;
        headXCount++;
      }
    }
  }

  const headSampleWidth = Math.max(10, headMaxX - headMinX);
  const headSampleCenterX =
    headXCount > 0 ? headXSum / headXCount : (minSampleX + maxSampleX) / 2;

  // 3. Scan face skin tone for chin location
  const skinMap = new Uint8Array(sampleW * sampleH);
  let skinCount = 0;
  let sumSkinX = 0;

  for (
    let y = headTopSampleY;
    y <= Math.min(sampleH - 1, headBottomSampleY);
    y++
  ) {
    for (let x = headMinX; x <= headMaxX; x++) {
      const i = (y * sampleW + x) * 4;
      if (maskData && maskData[i + 3] < 80) continue;

      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const isSkin =
        r > 60 &&
        g > 40 &&
        b > 20 &&
        Math.max(r, g, b) - Math.min(r, g, b) > 12 &&
        Math.abs(r - g) > 10 &&
        r > g &&
        r > b;

      if (isSkin) {
        skinMap[y * sampleW + x] = 1;
        skinCount++;
        sumSkinX += x;
      }
    }
  }

  let chinSampleY = -1;
  let faceCenterSampleX =
    skinCount > 20 ? sumSkinX / skinCount : headSampleCenterX;

  if (skinCount > 20) {
    let lastSkinY = headTopSampleY;
    for (let y = headTopSampleY; y <= headBottomSampleY; y++) {
      let rowSkin = 0;
      for (
        let x = Math.max(0, Math.floor(faceCenterSampleX - 25));
        x <= Math.min(sampleW - 1, Math.ceil(faceCenterSampleX + 25));
        x++
      ) {
        if (skinMap[y * sampleW + x]) rowSkin++;
      }
      if (rowSkin >= 3) {
        lastSkinY = y;
      }
    }
    chinSampleY = Math.min(headBottomSampleY, lastSkinY);
  }

  // Calculate face height (crown of head to chin)
  // Anatomically head height is ~1.28x head width or ~45% of head+torso cutout
  let rawDetectedFaceH =
    chinSampleY > headTopSampleY + 10
      ? chinSampleY - headTopSampleY
      : headSampleWidth * 1.28;

  // Cap face height to avoid counting exposed neck/chest skin as face
  const maxFaceH = Math.min(cutoutSampleH * 0.52, headSampleWidth * 1.35);
  const minFaceH = Math.max(15, headSampleWidth * 1.1);

  const sampleFaceHeight = Math.min(
    maxFaceH,
    Math.max(minFaceH, rawDetectedFaceH),
  );

  // Convert to full resolution coordinates
  const scaleX = w / sampleW;
  const scaleY = h / sampleH;

  const headTopY = headTopSampleY * scaleY;
  const faceHeight = sampleFaceHeight * scaleY;
  const chinY = headTopY + faceHeight;
  const faceCenterX = faceCenterSampleX * scaleX;

  return {
    headTopY,
    chinY,
    faceHeight,
    faceCenterX,
    fullW: w,
    fullH: h,
  };
}
