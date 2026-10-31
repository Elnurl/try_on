/**
 * Front packshots often include temple arms in the same PNG.
 * For live VTO we keep only the central frame + lenses (trim side wings).
 */
export function maskSideTemples(canvas, insetRatio = 0.16) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 8 || h < 8) return canvas;
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const col = new Float32Array(w);
  for (let x = 0; x < w; x += 1) {
    let n = 0;
    for (let y = 0; y < h; y += 1) {
      if (px[(y * w + x) * 4 + 3] > 24) n += 1;
    }
    col[x] = n / h;
  }
  let peak = 0;
  const x0 = Math.floor(w * 0.28);
  const x1 = Math.ceil(w * 0.72);
  for (let x = x0; x < x1; x += 1) peak = Math.max(peak, col[x]);
  if (peak < 0.02) return canvas;
  const edge = peak * 0.42;
  let left = 0;
  let right = w - 1;
  for (let x = 0; x < w; x += 1) {
    if (col[x] >= edge) {
      left = x;
      break;
    }
  }
  for (let x = w - 1; x >= 0; x -= 1) {
    if (col[x] >= edge) {
      right = x;
      break;
    }
  }
  const span = Math.max(4, right - left + 1);
  const inset = span * insetRatio;
  const keepL = Math.round(left + inset);
  const keepR = Math.round(right - inset);
  for (let x = 0; x < w; x += 1) {
    if (x >= keepL && x <= keepR) continue;
    for (let y = 0; y < h; y += 1) {
      px[(y * w + x) * 4 + 3] = 0;
    }
  }
  const feather = 3;
  for (let dx = 0; dx <= feather; dx += 1) {
    const t = 1 - dx / (feather + 1);
    for (const x of [keepL + dx, keepR - dx]) {
      if (x < 0 || x >= w) continue;
      for (let y = 0; y < h; y += 1) {
        const i = (y * w + x) * 4 + 3;
        px[i] = Math.round(px[i] * t);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function frameBounds(px, w, h) {
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (px[(y * w + x) * 4 + 3] > 30) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

/** Only the two lens ellipses — rim and bridge stay opaque. */
export function makeLensesTranslucent(canvas, alphaMul = 0.42) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 8 || h < 8) return canvas;
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const { minX, maxX, minY, maxY } = frameBounds(px, w, h);
  const span = maxX - minX + 1;
  const vspan = maxY - minY + 1;
  if (span < 8 || vspan < 8) return canvas;

  const lenses = [
    { cx: minX + span * 0.27, cy: minY + vspan * 0.52, rx: span * 0.17, ry: vspan * 0.28 },
    { cx: minX + span * 0.73, cy: minY + vspan * 0.52, rx: span * 0.17, ry: vspan * 0.28 },
  ];

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let inside = false;
      for (const L of lenses) {
        const dx = (x - L.cx) / L.rx;
        const dy = (y - L.cy) / L.ry;
        if (dx * dx + dy * dy <= 1) {
          inside = true;
          break;
        }
      }
      if (!inside) continue;
      const i = (y * w + x) * 4;
      const a = px[i + 3];
      if (a < 20) continue;
      px[i + 3] = Math.max(32, Math.round(a * alphaMul));
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function cloneCanvas(source) {
  const c = document.createElement("canvas");
  c.width = source.width;
  c.height = source.height;
  c.getContext("2d").drawImage(source, 0, 0);
  return c;
}

/** Live camera only — do not run on studio preview source. */
export function prepareLiveVtoTexture(sourceCanvas) {
  const c = cloneCanvas(sourceCanvas);
  maskSideTemples(c, 0.11);
  makeLensesTranslucent(c, 0.42);
  return c;
}
