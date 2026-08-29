/**
 * Live camera + photo try-on UI.
 * Face tracking goes through tryon-adapter.js (engine-agnostic interface).
 * Video/photos stay on-device; only anonymous usage counters hit the server.
 */
import { createTryonEngine } from "./tryon-adapter.js?v=2";

const body = document.body;
const slug = body.dataset.slug || "demo";
const mode = body.dataset.mode || "page";

const canvas = document.querySelector("#stage");
const ctx = canvas.getContext("2d");
const video = document.querySelector("#camera");
const framesEl = document.querySelector("#frames");
const statusEl = document.querySelector("#status");
const startBtn = document.querySelector("#start");
const liveBtn = document.querySelector("#live-btn");
const photoInput = document.querySelector("#photo");
const idleHint = document.querySelector("#idle-hint");
const privacyEl = document.querySelector("#privacy");
const productModel = document.querySelector("#product-model");
const productBrand = document.querySelector("#product-brand");
const lensesEl = document.querySelector("#lenses");
const addCart = document.querySelector("#add-cart");
const closeBtn = document.querySelector("#close");
const markEl = document.querySelector("#studio-mark");
const arPreview = document.querySelector("#ar-preview");

let engine = null;
let selected = null;
let lensColor = null;
let frameImages = new Map();
let stream = null;
let anim = 0;
let smooth = null;
let lastVideoTime = -1;
let photoBitmap = null;
let view = "idle";
let catalog = [];
let trackedTryon = false;
let tryonConfig = { engine: "overlay" };
let brandMeta = {};
let consented = false;

function track(event) {
  const body = new URLSearchParams({ event });
  fetch(`/api/brand/${slug}/track`, { method: "POST", body }).catch(() => {});
}

function setStatus(msg) {
  statusEl.hidden = !msg;
  statusEl.textContent = msg || "";
}

function setIdle(show) {
  if (idleHint) idleHint.hidden = !show;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Adaptive smoothing: tiny movements get heavy smoothing (kills jitter),
// fast head turns get light smoothing (kills lag).
function smoothPose(pose, next) {
  const move = Math.hypot(next.left.x - pose.left.x, next.left.y - pose.left.y);
  const t = Math.min(0.85, Math.max(0.18, move / 14));
  return {
    left: { x: lerp(pose.left.x, next.left.x, t), y: lerp(pose.left.y, next.left.y, t) },
    right: { x: lerp(pose.right.x, next.right.x, t), y: lerp(pose.right.y, next.right.y, t) },
  };
}

async function waitPng(img) {
  if (img.complete && img.naturalWidth) return;
  try {
    await img.decode();
  } catch {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
  }
}

async function loadEngine() {
  if (engine) return engine;
  setStatus("Model yüklənir…");
  if (!tryonConfig.engine) {
    tryonConfig = await (await fetch("/api/tryon-config")).json();
  }
  engine = await createTryonEngine({
    config: tryonConfig,
    preview: arPreview,
  });
  if (engine.kind === "deepar") {
    document.body.classList.add("engine-deepar");
    if (arPreview) arPreview.hidden = false;
  }
  return engine;
}

function syncProduct() {
  if (!selected) return;
  productModel.textContent = selected.model || selected.name;
  productBrand.textContent = selected.brand || "";
  renderAngles();
  lensesEl.innerHTML = "";
  (selected.lenses || []).forEach((color) => {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "swatch" + (color === lensColor ? " on" : "");
    sw.style.background = color;
    sw.addEventListener("click", () => {
      lensColor = color;
      lensesEl.querySelectorAll(".swatch").forEach((el) => el.classList.remove("on"));
      sw.classList.add("on");
      if (view === "photo") renderPhoto();
    });
    lensesEl.appendChild(sw);
  });
}

function showAngle(url) {
  stopCamera();
  view = "gallery";
  setIdle(false);
  setStatus("");
  const img = new Image();
  img.onload = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.fillStyle = "#f5f5f5";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
  };
  img.onerror = () => setStatus("Şəkil açılmadı.");
  img.src = url;
}

function renderAngles() {
  const box = document.querySelector("#angles");
  const label = document.querySelector("#angles-label");
  if (!box || !label) return;
  const angles = (selected && selected.angles) || [];
  box.innerHTML = "";
  label.hidden = angles.length === 0;
  box.hidden = angles.length === 0;
  angles.forEach((url) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "angle-item";
    btn.innerHTML = `<img alt="Məhsul görünüşü" src="${url}" loading="lazy" />`;
    btn.addEventListener("click", () => showAngle(url));
    box.appendChild(btn);
  });
}

async function loadBrand() {
  const res = await fetch(`/api/brand/${slug}`);
  if (!res.ok) throw new Error("Brend tapılmadı");
  const data = await res.json();
  catalog = data.frames;
  brandMeta = data;
  if (data.accent) {
    document.documentElement.style.setProperty("--accent", data.accent);
  }
  if (!catalog.length) {
    setStatus("Bu mağazada hələ eynək yoxdur. Brend paneldən yükləsin.");
    return;
  }
  if (privacyEl) privacyEl.textContent = data.privacy;
  if (markEl) markEl.textContent = (data.name || "VTO").slice(0, 18);
  const wanted = body.dataset.sku || new URLSearchParams(location.search).get("sku");
  selected = catalog.find((item) => item.id === wanted) || catalog[0];
  lensColor = null;
  framesEl.innerHTML = "";
  await Promise.all(
    catalog.map((item) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = item.image_url;
      frameImages.set(item.id, img);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "related-item" + (item.id === selected.id ? " on" : "");
      btn.innerHTML = `<img alt="" src="${item.image_url}" /><span>${item.model || item.name}</span><small>${item.brand || ""}</small>`;
      btn.addEventListener("click", () => {
        selected = item;
        lensColor = null;
        framesEl.querySelectorAll(".related-item").forEach((el) => el.classList.remove("on"));
        btn.classList.add("on");
        syncProduct();
        if (engine && engine.kind === "deepar") {
          engine.setItem(item).catch((err) => console.warn(err));
        }
        if (view === "photo") renderPhoto();
      });
      framesEl.appendChild(btn);
      // Non-fatal: one broken image must not take the whole catalog down.
      return waitPng(img).catch(() => {
        console.warn("Frame image failed to load:", item.image_url);
      });
    })
  );
  syncProduct();
  track("open");
}

function glassesLayer() {
  const png = frameImages.get(selected.id);
  if (!png || !png.naturalWidth) return null;
  const c = document.createElement("canvas");
  c.width = png.naturalWidth;
  c.height = png.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(png, 0, 0);
  if (lensColor) {
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = lensColor;
    g.globalAlpha = 0.35;
    g.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

function drawGlasses(left, right) {
  if (!selected) return false;
  const png = glassesLayer();
  if (!png) return false;

  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 8) return false;

  const angle = Math.atan2(dy, dx);
  const midX = (left.x + right.x) / 2;
  const midY = (left.y + right.y) / 2;
  const targetW = dist * selected.scale;
  const targetH = (png.height / png.width) * targetW;
  const nx = dx / dist;
  const ny = dy / dist;
  const py = nx;
  const cx = midX + nx * dist * selected.offset_x;
  const cy = midY + ny * dist * selected.offset_x + py * dist * selected.offset_y;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.drawImage(png, -targetW / 2, -targetH / 2, targetW, targetH);
  ctx.restore();
  if (!trackedTryon) {
    trackedTryon = true;
    track("tryon");
  }
  return true;
}

function poseToPixels(pose, width, height, mirror) {
  let left = { x: pose.left.x * width, y: pose.left.y * height };
  let right = { x: pose.right.x * width, y: pose.right.y * height };
  if (mirror) {
    left = { x: width - left.x, y: left.y };
    right = { x: width - right.x, y: right.y };
  }
  return { left, right };
}

function stopCamera() {
  cancelAnimationFrame(anim);
  anim = 0;
  if (engine && engine.kind === "deepar" && engine.stopLive) {
    engine.stopLive();
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  smooth = null;
}

function loop() {
  anim = requestAnimationFrame(loop);
  if (!video.videoWidth || !engine) return;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const w = canvas.width;
  const h = canvas.height;

  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();

  if (video.currentTime === lastVideoTime) {
    if (smooth) drawGlasses(smooth.left, smooth.right);
    return;
  }
  lastVideoTime = video.currentTime;

  const pose = engine.detectVideo(video, performance.now());
  if (!pose) {
    setStatus("Üzü kadra gətirin");
    return;
  }
  setStatus("");
  const eyes = poseToPixels(pose, w, h, true);
  smooth = smooth ? smoothPose(smooth, eyes) : eyes;
  drawGlasses(smooth.left, smooth.right);
}

async function startCamera() {
  setStatus("Kamera açılır…");
  await loadEngine();
  if (engine.kind === "deepar") {
    photoBitmap = null;
    setIdle(false);
    if (arPreview) arPreview.hidden = false;
    await engine.startLive();
    await engine.setItem(selected);
    view = "live";
    setStatus("");
    if (!trackedTryon) {
      trackedTryon = true;
      track("tryon");
    }
    return;
  }
  await engine.setMode("VIDEO");
  photoBitmap = null;
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  view = "live";
  setIdle(false);
  setStatus("");
  loop();
}

function snapshot() {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/jpeg", 0.92);
  a.download = `${slug}-tryon.jpg`;
  a.click();
}

function addToCart() {
  if (!selected) return;
  track("click");
  const buyUrl = (selected.buy_url || "").trim();
  const payload = {
    type: "vto-add-to-cart",
    sku: selected.id,
    brand: slug,
    name: selected.name,
    price: selected.price || 0,
    buy_url: buyUrl,
  };
  window.parent.postMessage(payload, "*");
  if (buyUrl) {
    if (mode === "embed") return;
    location.href = buyUrl;
    return;
  }
  const key = "tryon-cart-" + slug;
  let items = [];
  try {
    items = JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    items = [];
  }
  const found = items.find((row) => row.id === selected.id);
  if (found) found.qty += 1;
  else {
    items.push({
      id: selected.id,
      name: selected.model || selected.name,
      price: selected.price || 0,
      qty: 1,
    });
  }
  localStorage.setItem(key, JSON.stringify(items));
  if (mode === "embed") return;
  location.href = "/t/" + slug + "/cart";
}

async function renderPhoto() {
  if (!photoBitmap || !engine) return;
  canvas.width = photoBitmap.width;
  canvas.height = photoBitmap.height;
  ctx.drawImage(photoBitmap, 0, 0);
  let pose;
  try {
    pose = engine.detectImage(photoBitmap);
  } catch {
    pose = engine.detectImage(canvas);
  }
  if (!pose) {
    setStatus("Üz tapılmadı — öndən, işıqlı selfie seçin. Şəkil görünür, eynək oturmadı.");
    return;
  }
  const eyes = poseToPixels(pose, canvas.width, canvas.height, false);
  const ok = drawGlasses(eyes.left, eyes.right);
  setStatus(ok ? "" : "Eynək şəkli hələ yüklənməyib, yenidən yoxlayın.");
}

async function tryPhoto(file) {
  setStatus("Şəkil hazırlanır…");
  stopCamera();
  await loadEngine();
  if (engine.kind === "deepar") {
    const img = new Image();
    img.onload = () => {
      view = "photo";
      setIdle(false);
      if (arPreview) arPreview.hidden = false;
      engine.setItem(selected).then(() => engine.showPhoto(img));
      setStatus("");
    };
    img.src = URL.createObjectURL(file);
    return;
  }
  await engine.setMode("IMAGE");
  try {
    photoBitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    photoBitmap = await createImageBitmap(file);
  }
  view = "photo";
  setIdle(false);
  await renderPhoto();
}

function onCameraClick() {
  if (!consented) {
    const box = document.querySelector("#consent");
    if (box) box.hidden = false;
    return;
  }
  startCamera().catch((err) => {
    console.error(err);
    setIdle(true);
    if (err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
      setStatus("Kameraya icazə verilmədi. Brauzerin ünvan sətrindəki kamera işarəsindən icazə verin və yenidən cəhd edin.");
    } else if (err && err.name === "NotFoundError") {
      setStatus("Kamera tapılmadı. Bu cihazda kamera yoxdur — 'Şəkil' düyməsi ilə selfie yükləyin.");
    } else if (err && err.message && err.message.includes("AR modulu")) {
      setStatus(err.message);
    } else {
      setStatus("Kamera açılmadı. HTTPS və ya localhost lazımdır, sonra yenidən cəhd edin.");
    }
  });
}

startBtn.addEventListener("click", onCameraClick);
liveBtn.addEventListener("click", onCameraClick);
addCart.addEventListener("click", addToCart);
closeBtn.addEventListener("click", () => {
  window.parent.postMessage({ type: "vto-close" }, "*");
});
const consentYes = document.querySelector("#consent-yes");
const consentNo = document.querySelector("#consent-no");
const consentBox = document.querySelector("#consent");
if (consentYes) {
  consentYes.addEventListener("click", () => {
    consented = true;
    if (consentBox) consentBox.hidden = true;
    onCameraClick();
  });
}
if (consentNo) {
  consentNo.addEventListener("click", () => {
    if (consentBox) consentBox.hidden = true;
    setStatus("Kamera üçün razılıq verilmədi. Şəkil yükləməklə də yoxlaya bilərsiniz.");
  });
}
photoInput.addEventListener("change", () => {
  const file = photoInput.files && photoInput.files[0];
  if (!file) return;
  tryPhoto(file).catch((err) => {
    console.error(err);
    setIdle(true);
    if (err && err.message && err.message.includes("AR modulu")) {
      setStatus(err.message);
    } else {
      setStatus("Şəkil oxunmadı — başqa format (JPG/PNG) və ya başqa şəkil sınayın.");
    }
    photoInput.value = "";
  });
});

loadBrand().catch((err) => {
  console.error(err);
  productModel.textContent = "Kataloq yüklənmədi";
  productBrand.textContent = "";
  setStatus("Kataloq yüklənmədi. İnterneti yoxlayıb səhifəni yeniləyin.");
});
fetch("/api/tryon-config")
  .then((res) => res.json())
  .then((cfg) => {
    tryonConfig = cfg;
  })
  .catch(() => {});
if (mode === "embed") document.documentElement.classList.add("embed-mode");
if (mode !== "embed" && closeBtn) closeBtn.hidden = true;
