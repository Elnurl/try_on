import { createTryonEngine } from "./tryon-adapter.js?v=3";
import {
  buildGlasses3D,
  createFaceOverlay3D,
  exportGlb,
} from "./digitize3d.js?v=19";
import { prepareVtoTexture } from "./frame-mask.js?v=2";

const FACE_URL = "/static/studio-face.jpg";
const SLUG = "demo";

const fileFront = document.querySelector("#file-front");
const fileLeft = document.querySelector("#file-left");
const fileRight = document.querySelector("#file-right");
const labelFront = document.querySelector("#label-front");
const labelLeft = document.querySelector("#label-left");
const labelRight = document.querySelector("#label-right");
const extraInput = document.querySelector("#extra-files");
const extraLabel = document.querySelector("#extra-label");
const extraList = document.querySelector("#extra-list");
const cutoutWrap = document.querySelector("#cutout-wrap");
const cutoutPreview = document.querySelector("#cutout-preview");
const nameInput = document.querySelector("#name");
const frameMmInput = document.querySelector("#frame-mm");
const scaleInput = document.querySelector("#scale");
const offsetYInput = document.querySelector("#offset-y");
const statusEl = document.querySelector("#status");
const saveBtn = document.querySelector("#save");
const liveLink = document.querySelector("#live");
const canvas = document.querySelector("#preview");
const canvas3d = document.querySelector("#preview3d");
const ctx = canvas.getContext("2d");
const overlay3d = createFaceOverlay3D(canvas3d);

const faceImg = new Image();
faceImg.crossOrigin = "anonymous";

let engine = null;
let posePx = null;
let facePose = null;
let cutoutFront = null;
let cutoutLeft = null;
let cutoutRight = null;
let glasses3d = null;
let savedSku = "";
let extraFiles = [];

function frameWidthMm() {
  const v = Number(frameMmInput.value);
  return Number.isFinite(v) && v >= 80 && v <= 180 ? v : 140;
}

function setStatus(msg, kind = "") {
  statusEl.hidden = !msg;
  statusEl.textContent = msg || "";
  statusEl.dataset.kind = kind;
}

function skuFromName(name) {
  const base = (name || "eynek")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18);
  return `${base || "eynek"}-${Date.now().toString(36)}`;
}

function colorDist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.hypot(dr, dg, db);
}

function sampleBg(px, w, h) {
  const pts = [
    [2, 2],
    [w - 3, 2],
    [2, h - 3],
    [w - 3, h - 3],
    [Math.floor(w / 2), 2],
    [Math.floor(w / 2), h - 3],
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
  return [r / pts.length, g / pts.length, b / pts.length];
}

function cutoutGlasses(img) {
  const src = document.createElement("canvas");
  src.width = img.naturalWidth;
  src.height = img.naturalHeight;
  const sctx = src.getContext("2d");
  sctx.drawImage(img, 0, 0);
  const data = sctx.getImageData(0, 0, src.width, src.height);
  const px = data.data;
  const w = src.width;
  const h = src.height;

  let opaque = 0;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] > 10) opaque += 1;
  }
  const alreadyCut = opaque / (w * h) < 0.92 && px[3] < 250;

  if (!alreadyCut) {
    const bg = sampleBg(px, w, h);
    const thresh = 42;
    for (let i = 0; i < px.length; i += 4) {
      const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
      const dist = colorDist([px[i], px[i + 1], px[i + 2]], bg);
      if (dist < thresh || lum > 248) {
        px[i + 3] = 0;
      } else if (dist < thresh * 1.7) {
        px[i + 3] = Math.round(px[i + 3] * ((dist - thresh) / (thresh * 0.7)));
      }
    }
    sctx.putImageData(data, 0, 0);
  }

  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  const next = sctx.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (next[(y * w + x) * 4 + 3] > 12) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) {
    throw new Error("Eynək fondan ayrıla bilmədi. Açıq fonlu şəkil yükləyin.");
  }

  const pad = 8;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(src, minX, minY, cw, ch, 0, 0, cw, ch);
  return out;
}

function fallbackPose() {
  return {
    left: { x: canvas.width * 0.36, y: canvas.height * 0.42 },
    right: { x: canvas.width * 0.64, y: canvas.height * 0.42 },
  };
}

function drawGlasses2D() {
  if (!cutoutFront) return;
  const eyes = posePx || fallbackPose();
  const left = eyes.left;
  const right = eyes.right;
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 8) return;
  const scaleMul = Number(scaleInput.value) * (frameWidthMm() / 140);
  const angle = Math.atan2(dy, dx);
  const midX = (left.x + right.x) / 2;
  const midY = (left.y + right.y) / 2 + dist * Number(offsetYInput.value);
  const targetW = dist * scaleMul * 1.38;
  const targetH = (cutoutFront.height / cutoutFront.width) * targetW;
  ctx.save();
  ctx.translate(midX, midY);
  ctx.rotate(angle);
  ctx.drawImage(cutoutFront, -targetW / 2, -targetH / 2, targetW, targetH);
  ctx.restore();
}

function drawPreview() {
  if (!faceImg.naturalWidth) return;
  canvas.width = 720;
  canvas.height = Math.round(720 * (faceImg.naturalHeight / faceImg.naturalWidth));
  ctx.drawImage(faceImg, 0, 0, canvas.width, canvas.height);
  drawGlasses2D();

  canvas3d.width = canvas.width;
  canvas3d.height = canvas.height;
  overlay3d.resize(canvas.width, canvas.height);
  overlay3d.setBackground(faceImg, false);
  if (glasses3d) {
    const eyes = posePx || fallbackPose();
    overlay3d.place(
      eyes.left,
      eyes.right,
      Number(scaleInput.value),
      Number(offsetYInput.value),
      null,
      canvas.width,
      canvas.height,
      {
        frame_width_mm: frameWidthMm(),
        mesh_scale: 1,
        mirror: false,
      },
    );
  }
  overlay3d.render();
}

async function detectFace() {
  try {
    engine = await createTryonEngine({ config: { engine: "overlay" } });
    await engine.setMode("IMAGE");
    const pose = engine.detectImage(faceImg);
    if (!pose) {
      posePx = fallbackPose();
      facePose = null;
      return;
    }
    facePose = pose;
    posePx = {
      left: { x: pose.left.x * canvas.width, y: pose.left.y * canvas.height },
      right: { x: pose.right.x * canvas.width, y: pose.right.y * canvas.height },
    };
  } catch (err) {
    console.warn("[studio] face detect fallback", err);
    posePx = fallbackPose();
  }
}

async function loadFace() {
  await new Promise((resolve, reject) => {
    faceImg.onload = resolve;
    faceImg.onerror = reject;
    faceImg.src = FACE_URL;
  });
  canvas.width = 720;
  canvas.height = Math.round(720 * (faceImg.naturalHeight / faceImg.naturalWidth));
  canvas3d.width = canvas.width;
  canvas3d.height = canvas.height;
  drawPreview();
  await detectFace();
  drawPreview();
}

async function loadCutout(file) {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  return cutoutGlasses(img);
}

async function rebuildVtoModel() {
  saveBtn.disabled = true;
  liveLink.hidden = true;
  savedSku = "";

  const f = fileFront.files && fileFront.files[0];
  const l = fileLeft.files && fileLeft.files[0];
  const r = fileRight.files && fileRight.files[0];
  if (!f || !l || !r) {
    glasses3d = null;
    cutoutFront = null;
    overlay3d.clearGlasses();
    drawPreview();
    saveBtn.disabled = true;
    const missing = [!f && "ön", !l && "sol", !r && "sağ"].filter(Boolean).join(", ");
    if (missing) setStatus(`VTO üçün 3 şəkil lazımdır: ${missing}.`, "");
    return;
  }

  setStatus("3 şəkil emal olunur, 2.5D model qurulur…");
  try {
    cutoutFront = prepareVtoTexture(await loadCutout(f));
    cutoutLeft = await loadCutout(l);
    cutoutRight = await loadCutout(r);
    const mm = frameWidthMm();
    glasses3d = buildGlasses3D(cutoutFront, {
      leftCanvas: cutoutLeft,
      rightCanvas: cutoutRight,
      frameWidthMm: mm,
    });
    overlay3d.setObject(glasses3d, { frameWidthMm: mm });
  } catch (err) {
    glasses3d = null;
    cutoutFront = null;
    overlay3d.clearGlasses();
    setStatus(err.message || "Şəkil emal olunmadı.", "error");
    saveBtn.disabled = true;
    return;
  }

  cutoutPreview.src = cutoutFront.toDataURL("image/png");
  cutoutWrap.hidden = false;
  labelFront.textContent = `Ön: ${f.name}`;
  labelLeft.textContent = `Sol: ${l.name}`;
  labelRight.textContent = `Sağ: ${r.name}`;
  if (!nameInput.value.trim()) {
    nameInput.value = f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  }
  saveBtn.disabled = false;
  if (!posePx) {
    await detectFace();
  }
  setStatus("VTO modeli hazırdır. Ölçünü yoxla, «VTO hazır et».");
  drawPreview();
}

function onViewFilesChanged() {
  void rebuildVtoModel();
}

function renderExtraList() {
  if (!extraFiles.length) {
    extraList.hidden = true;
    extraList.innerHTML = "";
    extraLabel.textContent = "Yan / 3/4 / detal — bir və ya bir neçə şəkil";
    return;
  }
  extraList.hidden = false;
  extraList.innerHTML = "";
  extraFiles.slice(0, 6).forEach((f) => {
    const li = document.createElement("li");
    li.textContent = f.name;
    extraList.appendChild(li);
  });
  if (extraFiles.length > 6) {
    const li = document.createElement("li");
    li.textContent = `+${extraFiles.length - 6} (yalnız ilk 6 saxlanacaq)`;
    extraList.appendChild(li);
  }
  extraLabel.textContent = `${Math.min(extraFiles.length, 6)} əlavə şəkil seçildi`;
}

fileFront.addEventListener("change", onViewFilesChanged);
fileLeft.addEventListener("change", onViewFilesChanged);
fileRight.addEventListener("change", onViewFilesChanged);
extraInput.addEventListener("change", () => {
  extraFiles = Array.from(extraInput.files || []);
  renderExtraList();
});
frameMmInput.addEventListener("change", () => {
  if (cutoutFront) void rebuildVtoModel();
});
scaleInput.addEventListener("input", drawPreview);
offsetYInput.addEventListener("input", drawPreview);

function apiErrorMessage(res, payload) {
  if (res.status === 401) {
    return "Giriş lazımdır: /admin/login aç, daxil ol, sonra /studio-ya qayıt.";
  }
  if (res.status === 404) {
    return "API tapılmadı — serveri yenidən başlat (uvicorn --reload).";
  }
  if (res.status === 502 || res.status === 503) {
    return "Server hazırlanır (502). 30 saniyə gözlə, Ctrl+F5, yenidən «VTO hazır et».";
  }
  const detail = payload.detail;
  if (Array.isArray(detail)) {
    return detail.map((d) => d.msg || d).join(" ");
  }
  return detail || `Server xətası (${res.status}). Yenidən cəhd edin.`;
}

async function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG yaradılmadı"))), "image/png");
  });
}

async function buildPublishForm(sku, name, blob, glb) {
  const fd = new FormData();
  fd.append("sku", sku);
  fd.append("name", name);
  fd.append("brand", "Studio");
  fd.append("scale", scaleInput.value);
  fd.append("offset_x", "0");
  fd.append("offset_y", offsetYInput.value);
  fd.append("frame_width_mm", String(frameWidthMm()));
  fd.append("tryon", "1");
  fd.append("file", blob, `${sku}.png`);
  fd.append("model", glb, `${sku}.glb`);
  if (cutoutLeft) {
    fd.append("extra", await canvasToPngBlob(cutoutLeft), `${sku}-profile-left.png`);
  }
  if (cutoutRight) {
    fd.append("extra", await canvasToPngBlob(cutoutRight), `${sku}-profile-right.png`);
  }
  extraFiles.slice(0, 6).forEach((f) => fd.append("extra", f, f.name));
  return fd;
}

async function waitForHealth(maxMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch("/api/health", { cache: "no-store", credentials: "same-origin" });
      if (res.ok) return true;
    } catch (_) {
      /* Render deploy / cold start */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function fetchWithRetry(url, options, tries = 5) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 5000 * i));
    try {
      const res = await fetch(url, options);
      if (res.status !== 502 && res.status !== 503) return res;
      last = res;
    } catch (err) {
      last = err;
    }
  }
  if (last && last.status) return last;
  throw last || new Error("Şəbəkə xətası");
}

async function publishVto(sku, name, blob, glb) {
  const opts = { method: "POST", credentials: "include" };
  const fd = await buildPublishForm(sku, name, blob, glb);
  let res = await fetchWithRetry(`/api/brand/${SLUG}/frames`, { ...opts, body: fd });
  let payload = await res.json().catch(() => ({}));
  if (res.status === 404) {
    return { res, payload };
  }
  if (res.ok) {
    return {
      res,
      payload: {
        ok: true,
        sku: payload.id || sku,
        tryon_url: `/t/${SLUG}?sku=${encodeURIComponent(payload.id || sku)}`,
        angles: (payload.angles && payload.angles.length) || 0,
        item: payload,
      },
    };
  }
  const fd2 = await buildPublishForm(sku, name, blob, glb);
  fd2.append("slug", SLUG);
  res = await fetchWithRetry("/api/studio/publish", { ...opts, body: fd2 });
  payload = await res.json().catch(() => ({}));
  return { res, payload };
}

saveBtn.addEventListener("click", async () => {
  if (!cutoutFront || !glasses3d) {
    setStatus("Əvvəl 3 bucaq şəkil yükləyin (ön, sol, sağ).", "error");
    return;
  }
  const name = nameInput.value.trim() || "Demo eynək";
  const sku = skuFromName(name);
  setStatus("Server yoxlanır…");
  saveBtn.disabled = true;

  try {
    const up = await waitForHealth();
    if (!up) {
      setStatus(
        "Server hazır deyil (502). Render deploy bitənə qədər 1–2 dəq gözlə, Ctrl+F5, yenidən cəhd et.",
        "error",
      );
      saveBtn.disabled = false;
      return;
    }
    setStatus("Addım 2–3: kataloq + VTO link yaradılır…");
    const blob = await new Promise((resolve, reject) => {
      cutoutFront.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG yaradılmadı"))), "image/png");
    });
    const glb = await exportGlb(glasses3d);
    const { res, payload } = await publishVto(sku, name, blob, glb);
    if (!res.ok) {
      setStatus(apiErrorMessage(res, payload), "error");
      saveBtn.disabled = false;
      return;
    }
    savedSku = payload.sku || payload.id || sku;
    const tryUrl =
      payload.tryon_url || `/t/${SLUG}?sku=${encodeURIComponent(savedSku)}`;
    liveLink.href = tryUrl;
    liveLink.hidden = false;
    saveBtn.disabled = false;
    const anglesN = payload.angles ?? (payload.item && payload.item.angles && payload.item.angles.length);
    const extraNote = anglesN ? ` · ${anglesN} əlavə şəkil` : "";
    setStatus(`Addım 3 tamam: VTO hazırdır${extraNote}. «Kamerada yoxla» bas.`, "ok");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Gözlənilməz xəta.", "error");
    saveBtn.disabled = false;
  }
});

void loadFace().catch((err) => {
  console.error(err);
  setStatus("Model üzü yüklənmədi.", "error");
});
