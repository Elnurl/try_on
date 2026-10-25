/**
 * EYNƏK own placement engine.
 * Product photo → cutout → front frame → sit on the eyes (not the forehead).
 *
 * scale is a multiple of outer-eye distance (landmarks 33–263).
 * Typical frames are ~1.35–1.5× that span, not 2.2×.
 */

function colorDist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function alphaBBox(px, w, h, cutoff = 16) {
  let left = w;
  let right = 0;
  let top = h;
  let bottom = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (px[(y * w + x) * 4 + 3] > cutoff) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < left) return null;
  return { left, right, top, bottom };
}

function cropCanvas(src, box, pad = 4) {
  const left = Math.max(0, box.left - pad);
  const top = Math.max(0, box.top - pad);
  const right = Math.min(src.width - 1, box.right + pad);
  const bottom = Math.min(src.height - 1, box.bottom + pad);
  const out = document.createElement("canvas");
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  out.getContext("2d").drawImage(src, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function massCenter(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const px = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  let sum = 0;
  let accX = 0;
  let accY = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = px[(y * w + x) * 4 + 3];
      if (a > 16) {
        sum += a;
        accX += x * a;
        accY += y * a;
      }
    }
  }
  return {
    x: sum ? accX / sum : w / 2,
    y: sum ? accY / sum : h / 2,
  };
}

export function cutoutGlasses(img, opts = {}) {
  const src = document.createElement("canvas");
  src.width = img.naturalWidth || img.width;
  src.height = img.naturalHeight || img.height;
  const ctx = src.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, src.width, src.height);
  const px = data.data;
  const w = src.width;
  const h = src.height;

  let opaque = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 12) opaque += 1;
  const alreadyCut = opaque / (w * h) < 0.9 && px[3] < 250;

  if (!alreadyCut) {
    const pts = [
      [2, 2],
      [w - 3, 2],
      [2, h - 3],
      [w - 3, h - 3],
      [Math.floor(w / 2), 2],
    ];
    let r = 0;
    let g = 0;
    let b = 0;
    for (const [x, y] of pts) {
      const i = (y * w + x) * 4;
      r += px[i];
      g += px[i + 1];
      b += px[i + 2];
    }
    const bg = [r / pts.length, g / pts.length, b / pts.length];
    for (let i = 0; i < px.length; i += 4) {
      const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
      const dist = colorDist([px[i], px[i + 1], px[i + 2]], bg);
      if (dist < 40 || lum > 247) px[i + 3] = 0;
      else if (dist < 68) px[i + 3] = Math.round(px[i + 3] * ((dist - 40) / 28));
    }
    ctx.putImageData(data, 0, 0);
  }

  return extractFront(src, opts);
}

export function extractFront(canvas, opts = {}) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  const px = ctx.getImageData(0, 0, w, h).data;
  const rowW = new Array(h).fill(0);
  let maxW = 0;
  for (let y = 0; y < h; y += 1) {
    let minX = w;
    let maxX = 0;
    for (let x = 0; x < w; x += 1) {
      if (px[(y * w + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    rowW[y] = maxX >= minX ? maxX - minX + 1 : 0;
    if (rowW[y] > maxW) maxW = rowW[y];
  }
  if (maxW < 8) throw new Error("Eynək fondan ayrıla bilmədi.");

  const keep = maxW * 0.55;
  let top = 0;
  let bottom = h - 1;
  while (top < h && rowW[top] < keep) top += 1;
  while (bottom > top && rowW[bottom] < keep) bottom -= 1;

  let left = w;
  let right = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (px[(y * w + x) * 4 + 3] > 16) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  const colCount = new Array(w).fill(0);
  for (let x = 0; x < w; x += 1) {
    for (let y = top; y <= bottom; y += 1) {
      if (px[(y * w + x) * 4 + 3] > 16) colCount[x] += 1;
    }
  }
  const peak = Math.max(...colCount, 1);
  while (left < right && colCount[left] < peak * 0.18) left += 1;
  while (right > left && colCount[right] < peak * 0.18) right -= 1;

  // Temples sit on the upper rim. If the widest rows are in the bottom
  // half, the product photo is upside down — flip it before placing.
  let templeWeight = 0;
  let templeMoment = 0;
  for (let y = 0; y < h; y += 1) {
    if (rowW[y] > maxW * 0.9) {
      templeWeight += 1;
      templeMoment += y;
    }
  }
  let source = canvas;
  if (templeWeight > 0 && templeMoment / templeWeight > h * 0.58) {
    source = flipCanvasY(canvas);
    const flipped = {
      left,
      right,
      top: h - 1 - bottom,
      bottom: h - 1 - top,
    };
    left = flipped.left;
    right = flipped.right;
    top = flipped.top;
    bottom = flipped.bottom;
  }

  const out = cropCanvas(source, { left, right, top, bottom }, 6);
  const box = alphaBBox(out.getContext("2d").getImageData(0, 0, out.width, out.height).data, out.width, out.height);
  const front = box ? cropCanvas(out, box, 3) : out;
  if (!opts.keepLenses) openLenses(front);
  featherAlpha(front);
  front._mass = massCenter(front);
  const rim = sampleRim(front);
  front._rim = rim.css;
  front._rimRgb = rim.rgb;
  return front;
}

function openLenses(canvas) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext("2d");
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (px[i + 3] < 20) continue;
      const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
      const edge = x < w * 0.07 || x > w * 0.93 || y < h * 0.08 || y > h * 0.92;
      if (!edge && lum > 145) px[i + 3] = Math.min(px[i + 3], 48);
    }
  }
  ctx.putImageData(data, 0, 0);
}

function featherAlpha(canvas) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext("2d");
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const copy = new Uint8ClampedArray(px);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = (y * w + x) * 4 + 3;
      if (copy[i] < 8) continue;
      let minA = copy[i];
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const a = copy[((y + oy) * w + (x + ox)) * 4 + 3];
          if (a < minA) minA = a;
        }
      }
      if (minA < 20) px[i] = Math.round(px[i] * 0.55);
    }
  }
  ctx.putImageData(data, 0, 0);
}

function flipCanvasY(src) {
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const c = out.getContext("2d");
  c.translate(0, src.height);
  c.scale(1, -1);
  c.drawImage(src, 0, 0);
  return out;
}

function sampleRim(canvas) {
  const { width: w, height: h } = canvas;
  const px = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 36))) {
    for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 36))) {
      const i = (y * w + x) * 4;
      if (px[i + 3] < 80) continue;
      const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
      const edge = x < w * 0.1 || x > w * 0.9 || y < h * 0.16 || y > h * 0.84;
      if (!edge || lum > 210) continue;
      r += px[i];
      g += px[i + 1];
      b += px[i + 2];
      n += 1;
    }
  }
  if (!n) return { css: "rgb(28,28,28)", rgb: [28, 28, 28] };
  r = Math.round(r / n);
  g = Math.round(g / n);
  b = Math.round(b / n);
  return { css: `rgb(${r},${g},${b})`, rgb: [r, g, b] };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mapPoint(p, width, height, mirror) {
  if (!p) return null;
  return {
    x: mirror ? (1 - p.x) * width : p.x * width,
    y: p.y * height,
    z: p.z || 0,
  };
}

function pickScreenLeft(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.x <= b.x ? a : b;
}

function pickScreenRight(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.x <= b.x ? b : a;
}

function drawTexturedTriangle(ctx, img, d0, d1, d2, s0, s1, s2) {
  const den = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(den) < 1e-3) return;
  const m11 = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / den;
  const m12 = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / den;
  const m21 = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / den;
  const m22 = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / den;
  const dx = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / den;
  const dy = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / den;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(m11, m21, m12, m22, dx, dy);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function drawTexturedQuadUV(ctx, img, tl, tr, br, bl, u0, u1, flipU) {
  const w = img.width;
  const h = img.height;
  let leftU = u0 * w;
  let rightU = u1 * w;
  if (flipU) {
    leftU = (1 - u0) * w;
    rightU = (1 - u1) * w;
  }
  const sTL = { x: leftU, y: 0 };
  const sTR = { x: rightU, y: 0 };
  const sBR = { x: rightU, y: h };
  const sBL = { x: leftU, y: h };
  drawTexturedTriangle(ctx, img, tl, tr, bl, sTL, sTR, sBL);
  drawTexturedTriangle(ctx, img, tr, br, bl, sTR, sBR, sBL);
}

function pullToward(p, target, amt) {
  if (!p || !target || amt <= 0) return p;
  const dx = target.x - p.x;
  const dy = target.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: p.x + (dx / len) * amt, y: p.y + (dy / len) * amt };
}

function bezier(a, c, b, t) {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

function clipOutsideFace(ctx, width, height, contour) {
  if (!contour || contour.length < 8) return false;
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.moveTo(contour[0].x, contour[0].y);
  for (let i = 1; i < contour.length; i += 1) ctx.lineTo(contour[i].x, contour[i].y);
  ctx.closePath();
  ctx.clip("evenodd");
  return true;
}

function drawTemple(ctx, hinge, ear, dist, vis, rgb, width, height, contour) {
  if (!hinge || !ear || vis < 0.12) return;
  const dx = ear.x - hinge.x;
  const dy = ear.y - hinge.y;
  const len = Math.hypot(dx, dy);
  if (len < 6) return;
  const use = Math.min(len * 0.88, dist * 0.62) * (0.45 + 0.55 * vis);
  const nx = dx / len;
  const ny = dy / len;
  const end = { x: hinge.x + nx * use, y: hinge.y + ny * use + dist * 0.06 };
  const ctrl = { x: hinge.x + nx * use * 0.5, y: hinge.y + ny * use * 0.32 + dist * 0.01 };
  const steps = 7;
  const top = [];
  const bot = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const p = bezier(hinge, ctrl, end, t);
    const nxt = bezier(hinge, ctrl, end, Math.min(1, t + 0.08));
    const tx = nxt.x - p.x;
    const ty = nxt.y - p.y;
    const tl = Math.hypot(tx, ty) || 1;
    const px = -ty / tl;
    const py = tx / tl;
    const half = dist * (0.028 * (1 - t * 0.72) + 0.007) * (0.75 + 0.35 * vis);
    top.push({ x: p.x + px * half, y: p.y + py * half });
    bot.push({ x: p.x - px * half, y: p.y - py * half });
  }
  ctx.save();
  clipOutsideFace(ctx, width, height, contour);
  ctx.globalAlpha = 0.55 + 0.4 * vis;
  ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  ctx.beginPath();
  ctx.moveTo(top[0].x, top[0].y);
  for (let i = 1; i < top.length; i += 1) ctx.lineTo(top[i].x, top[i].y);
  for (let i = bot.length - 1; i >= 0; i -= 1) ctx.lineTo(bot[i].x, bot[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.2 + 0.25 * vis;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = Math.max(1, dist * 0.012);
  ctx.beginPath();
  ctx.moveTo(top[0].x, top[0].y);
  for (let i = 1; i < top.length; i += 1) ctx.lineTo(top[i].x, top[i].y);
  ctx.stroke();
  ctx.restore();
}

function fillEllipse(ctx, cx, cy, rw, rh, angle, fill) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.scale(rw, rh);
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

function drawShadow(ctx, tl, tr, br, bl, dist, bridge, nose) {
  const cx = (tl.x + tr.x + br.x + bl.x) / 4;
  const cy = (tl.y + tr.y + br.y + bl.y) / 4 + dist * 0.035;
  const rw = Math.hypot(tr.x - tl.x, tr.y - tl.y) * 0.5;
  const rh = Math.hypot(bl.x - tl.x, bl.y - tl.y) * 0.22;
  const ang = Math.atan2(tr.y - tl.y, tr.x - tl.x);
  fillEllipse(ctx, cx, cy, rw, rh, ang, "rgba(0,0,0,0.1)");
  fillEllipse(ctx, cx, cy + rh * 0.15, rw * 0.82, rh * 0.7, ang, "rgba(0,0,0,0.12)");
  const nx = (bridge && bridge.x) || cx;
  const ny = ((nose && nose.y) || cy) - dist * 0.02;
  fillEllipse(ctx, nx, ny + dist * 0.06, dist * 0.12, dist * 0.055, ang, "rgba(0,0,0,0.2)");
}

function sampleFaceLight(ctx, eyeL, eyeR, dist) {
  const x = Math.max(0, Math.round(Math.min(eyeL.x, eyeR.x) - dist * 0.15));
  const y = Math.max(0, Math.round(Math.min(eyeL.y, eyeR.y) + dist * 0.18));
  const w = Math.max(4, Math.round(dist * 1.25));
  const h = Math.max(4, Math.round(dist * 0.35));
  let data;
  try {
    data = ctx.getImageData(x, y, w, h).data;
  } catch {
    return { r: 170, g: 145, b: 125, lum: 0.58, dir: 0 };
  }
  let rL = 0;
  let gL = 0;
  let bL = 0;
  let nL = 0;
  let rR = 0;
  let gR = 0;
  let bR = 0;
  let nR = 0;
  const step = 8;
  for (let i = 0; i < data.length; i += 4 * step) {
    const col = Math.floor((i / 4) % w);
    if (col < w / 2) {
      rL += data[i];
      gL += data[i + 1];
      bL += data[i + 2];
      nL += 1;
    } else {
      rR += data[i];
      gR += data[i + 1];
      bR += data[i + 2];
      nR += 1;
    }
  }
  const r = ((nL ? rL / nL : 160) + (nR ? rR / nR : 160)) / 2;
  const g = ((nL ? gL / nL : 140) + (nR ? gR / nR : 140)) / 2;
  const b = ((nL ? bL / nL : 120) + (nR ? bR / nR : 120)) / 2;
  const lumL = nL ? (rL + gL + bL) / (nL * 765) : 0.5;
  const lumR = nR ? (rR + gR + bR) / (nR * 765) : 0.5;
  return { r, g, b, lum: (r + g + b) / 765, dir: lumR - lumL };
}

function drawLensGlint(ctx, tl, tr, br, bl, lightDir) {
  const cx = (tl.x + tr.x + br.x + bl.x) / 4;
  const cy = (tl.y + tr.y + br.y + bl.y) / 4;
  const gx = cx + (tr.x - tl.x) * (0.18 + lightDir * 0.2);
  const gy = cy - Math.hypot(tr.x - tl.x, tr.y - tl.y) * 0.12;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.clip();
  const grad = ctx.createRadialGradient(gx, gy, 2, gx, gy, Math.hypot(tr.x - tl.x, tr.y - tl.y) * 0.38);
  grad.addColorStop(0, "rgba(255,255,255,0.28)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.08)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
}

export function placeGlasses(ctx, glasses, pose, width, height, opts = {}) {
  if (!glasses || !pose) return false;
  const scale = opts.scale ?? 1.42;
  const offsetY = opts.offsetY ?? 0.04;
  const mirror = !!opts.mirror;

  const eyeA = mapPoint(pose.left, width, height, mirror);
  const eyeB = mapPoint(pose.right, width, height, mirror);
  const bridge = mapPoint(pose.bridge || {
    x: (pose.left.x + pose.right.x) / 2,
    y: (pose.left.y + pose.right.y) / 2,
    z: 0,
  }, width, height, mirror);
  const nose = mapPoint(pose.nose, width, height, mirror);
  const cheekL = pickScreenLeft(
    mapPoint(pose.leftCheek, width, height, mirror),
    mapPoint(pose.rightCheek, width, height, mirror),
  );
  const cheekR = pickScreenRight(
    mapPoint(pose.leftCheek, width, height, mirror),
    mapPoint(pose.rightCheek, width, height, mirror),
  );
  const earL = pickScreenLeft(
    mapPoint(pose.leftEar, width, height, mirror),
    mapPoint(pose.rightEar, width, height, mirror),
  ) || cheekL;
  const earR = pickScreenRight(
    mapPoint(pose.leftEar, width, height, mirror),
    mapPoint(pose.rightEar, width, height, mirror),
  ) || cheekR;

  const eyeL = pickScreenLeft(eyeA, eyeB);
  const eyeR = pickScreenRight(eyeA, eyeB);
  const dx = eyeR.x - eyeL.x;
  const dy = eyeR.y - eyeL.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 10) return false;

  const roll = Math.atan2(dy, dx);
  const ux = { x: Math.cos(roll), y: Math.sin(roll) };
  const uy = { x: -Math.sin(roll), y: Math.cos(roll) };

  const midX = (eyeL.x + eyeR.x) / 2;
  const midY = (eyeL.y + eyeR.y) / 2;
  const noseX = nose ? nose.x : midX;
  const noseY = nose ? nose.y : midY;
  const yaw = clamp((noseX - midX) / dist * 2.2, -0.9, 0.9);
  const pitch = clamp((noseY - midY) / dist * 1.6, -0.7, 0.7);

  const zL = eyeL.z || 0;
  const zR = eyeR.z || 0;
  const zSpan = Math.max(0.04, Math.abs(zL - zR) + 0.08);
  let sL = 1 + 0.7 * ((zR - zL) / zSpan) - yaw * 0.42;
  let sR = 1 + 0.7 * ((zL - zR) / zSpan) + yaw * 0.42;
  sL = clamp(sL, 0.58, 1.42);
  sR = clamp(sR, 0.58, 1.42);

  const halfW = (dist * scale) / 2;
  const halfH = halfW * (glasses.height / glasses.width);
  const cx = bridge.x;
  const cy = midY + dist * offsetY;
  const center = { x: cx, y: cy };
  const top = 1 + pitch * 0.28;
  const bot = 1 - pitch * 0.16;
  const squeezeL = sL < sR ? 0.16 : 0;
  const squeezeR = sR < sL ? 0.16 : 0;

  const leftOut = ux.x * halfW * sL * (1 - squeezeL);
  const rightOut = ux.x * halfW * sR * (1 - squeezeR);
  const leftOutY = ux.y * halfW * sL * (1 - squeezeL);
  const rightOutY = ux.y * halfW * sR * (1 - squeezeR);

  let tl = { x: center.x - leftOut - uy.x * halfH * top, y: center.y - leftOutY - uy.y * halfH * top };
  let tr = { x: center.x + rightOut - uy.x * halfH * top, y: center.y + rightOutY - uy.y * halfH * top };
  let bl = { x: center.x - leftOut + uy.x * halfH * bot, y: center.y - leftOutY + uy.y * halfH * bot };
  let br = { x: center.x + rightOut + uy.x * halfH * bot, y: center.y + rightOutY + uy.y * halfH * bot };

  const wrap = dist * (0.11 + Math.abs(yaw) * 0.14);
  tl = pullToward(tl, cheekL || earL, wrap * (1.15 - sL));
  bl = pullToward(bl, cheekL || earL, wrap * (1.15 - sL));
  tr = pullToward(tr, cheekR || earR, wrap * (1.15 - sR));
  br = pullToward(br, cheekR || earR, wrap * (1.15 - sR));

  const midTop = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 - dist * 0.012 };
  const midBot = { x: (bl.x + br.x) / 2, y: (bl.y + br.y) / 2 };

  const leftHinge = { x: (tl.x + bl.x) / 2, y: (tl.y + bl.y) / 2 };
  const rightHinge = { x: (tr.x + br.x) / 2, y: (tr.y + br.y) / 2 };
  const visL = clamp(0.55 + (sL - 1) * 0.8, 0.22, 1);
  const visR = clamp(0.55 + (sR - 1) * 0.8, 0.22, 1);
  const rimRgb = glasses._rimRgb || [32, 32, 32];
  const contour = (pose.contour || [])
    .map((p) => mapPoint(p, width, height, mirror))
    .filter(Boolean);
  const light = sampleFaceLight(ctx, eyeL, eyeR, dist);

  if (visL <= visR) {
    drawTemple(ctx, leftHinge, earL || cheekL, dist, visL * 0.9, rimRgb, width, height, contour);
    drawTemple(ctx, rightHinge, earR || cheekR, dist, visR, rimRgb, width, height, contour);
  } else {
    drawTemple(ctx, rightHinge, earR || cheekR, dist, visR * 0.9, rimRgb, width, height, contour);
    drawTemple(ctx, leftHinge, earL || cheekL, dist, visL, rimRgb, width, height, contour);
  }
  drawShadow(ctx, tl, tr, br, bl, dist, bridge, nose);

  ctx.save();
  ctx.globalAlpha = 0.88 + light.lum * 0.12;
  drawTexturedQuadUV(ctx, glasses, tl, midTop, midBot, bl, 0, 0.5, mirror);
  drawTexturedQuadUV(ctx, glasses, midTop, tr, br, midBot, 0.5, 1, mirror);
  ctx.globalCompositeOperation = "soft-light";
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = `rgb(${Math.round(light.r)},${Math.round(light.g)},${Math.round(light.b)})`;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  drawLensGlint(ctx, tl, midTop, midBot, bl, -light.dir);
  drawLensGlint(ctx, midTop, tr, br, midBot, light.dir);
  return true;
}
