/**
 * Live camera + photo try-on UI.
 * Face tracking goes through tryon-adapter.js (engine-agnostic interface).
 * Video/photos stay on-device; only anonymous usage counters hit the server.
 */
import { createTryonEngine } from "./tryon-adapter.js?v=2";
import { createFaceOverlay3D } from "./digitize3d.js?v=10";

const body = document.body;
const slug = body.dataset.slug || "demo";
const mode = body.dataset.mode || "page";

const canvas = document.querySelector("#stage");
const ctx = canvas.getContext("2d");
const stage3d = document.querySelector("#stage3d");
const overlay3d = stage3d ? createFaceOverlay3D(stage3d) : null;
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
let tryonConfig = null;
let brandMeta = {};
let consented = false;
let loadedModelUrl = "";
let meshLoadError = "";
let lastFacePose = null;

async function ensureTryonConfig() {
  if (tryonConfig) return tryonConfig;
  try {
    tryonConfig = await (await fetch("/api/tryon-config")).json();
  } catch {
    tryonConfig = { engine: "overlay" };
  }
  return tryonConfig;
}

function pickFrame(items, wanted) {
  if (wanted) {
    const hit = items.find((item) => item.id === wanted);
    if (hit) return hit;
  }
  const uploads = items.filter((item) => item.custom && item.model_url && item.tryon !== false);
  if (uploads.length) return uploads[uploads.length - 1];
  const ql = items.find((item) => item.id === "ql2009-c1" && item.model_url);
  if (ql) return ql;
  const mesh = items.find((item) => item.model_url);
  if (mesh) return mesh;
  return items[0];
}

function usesMeshVto() {
  return !!(selected && selected.model_url);
}

function meshReady() {
  return usesMeshVto() && loadedModelUrl === selected.model_url && !meshLoadError;
}

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

async function deeparEffectReady(item) {
  if (!item || !item.effect_url) return false;
  if (tryonConfig.deeparEffects && Object.prototype.hasOwnProperty.call(tryonConfig.deeparEffects, item.id)) {
    return !!tryonConfig.deeparEffects[item.id];
  }
  try {
    const res = await fetch(item.effect_url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function shouldUseDeepAR(item) {
  if (tryonConfig.engine !== "deepar" || !tryonConfig.licenseKey) return false;
  if (!item) return false;
  // Studio / photo pipeline: mesh VTO from uploaded GLB unless a real .deepar is deployed.
  if (item.model_url || item.digitized || item.custom) {
    if (
      item.effect_url &&
      tryonConfig.deeparEffects &&
      Object.prototype.hasOwnProperty.call(tryonConfig.deeparEffects, item.id)
    ) {
      return !!tryonConfig.deeparEffects[item.id];
    }
    if (item.effect_url) return deeparEffectReady(item);
    return false;
  }
  if (!item.effect_url) return false;
  return deeparEffectReady(item);
}

function syncEngineClasses() {
  const deepar = !!(engine && engine.kind === "deepar");
  const mesh =
    !deepar &&
    !!(selected && selected.model_url) &&
    (!engine || engine.kind === "overlay");
  document.body.classList.toggle("engine-deepar", deepar);
  document.body.classList.toggle("engine-mesh", mesh);
}

async function loadEngine(forceReload = false) {
  if (engine && !forceReload) return engine;
  setStatus("Model yüklənir…");
  await ensureTryonConfig();
  const useDeepar = await shouldUseDeepAR(selected);
  engine = await createTryonEngine({
    config: tryonConfig,
    preview: arPreview,
    forceOverlay: !useDeepar,
  });
  syncEngineClasses();
  if (engine.kind === "deepar") {
    if (arPreview) arPreview.hidden = false;
  } else if (arPreview) {
    arPreview.hidden = true;
  }
  return engine;
}

function syncProduct() {
  if (!selected) return;
  productModel.textContent = selected.model || selected.name;
  syncEngineClasses();
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
  await ensureTryonConfig();
  const res = await fetch(`/api/brand/${slug}`);
  if (!res.ok) throw new Error("Brend tapılmadı");
  const data = await res.json();
  catalog = data.frames;
  brandMeta = data;
  if (data.accent) {
    document.documentElement.style.setProperty("--accent", data.accent);
  }
  if (addCart) {
    addCart.hidden = !(data.cart_url || "").trim();
  }
  if (!catalog.length) {
    setStatus("Bu mağazada hələ eynək yoxdur. Brend paneldən yükləsin.");
    return;
  }
  if (privacyEl) privacyEl.textContent = data.privacy;
  const wanted = body.dataset.sku || new URLSearchParams(location.search).get("sku");
  selected = pickFrame(catalog, wanted);
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
        void (async () => {
          selected = item;
          lensColor = null;
          framesEl.querySelectorAll(".related-item").forEach((el) => el.classList.remove("on"));
          btn.classList.add("on");
          syncProduct();
          await sync3DModel().catch((err) => console.warn(err));
          if (view === "live" && engine) {
            const wantDeepar = await shouldUseDeepAR(selected);
            const haveDeepar = engine.kind === "deepar";
            if (wantDeepar !== haveDeepar) {
              stopCamera();
              engine = null;
              await startCamera().catch((err) => console.warn(err));
              return;
            }
          }
          if (engine && engine.kind === "deepar") {
            engine.setItem(item).catch((err) => console.warn(err));
          }
          syncEngineClasses();
          if (view === "photo") renderPhoto();
        })();
      });
      framesEl.appendChild(btn);
      // Non-fatal: one broken image must not take the whole catalog down.
      return waitPng(img).catch(() => {
        console.warn("Frame image failed to load:", item.image_url);
      });
    })
  );
  syncProduct();
  syncEngineClasses();
  sync3DModel().catch((err) => console.warn(err));
  track("open");
}

async function sync3DModel() {
  if (!overlay3d || !selected) return;
  const url = selected.model_url;
  meshLoadError = "";
  if (!url) {
    overlay3d.clearGlasses();
    loadedModelUrl = "";
    overlay3d.render();
    return;
  }
  if (url === loadedModelUrl) return;
  setStatus("3D eynək yüklənir…");
  try {
    await overlay3d.loadUrl(url, {
      frameWidthMm: selected.frame_width_mm,
      digitized: selected.digitized,
      custom: selected.custom,
    });
    loadedModelUrl = url;
    setStatus("");
  } catch (err) {
    console.error(err);
    loadedModelUrl = "";
    meshLoadError = err.message || "load failed";
    setStatus("3D model yüklənmədi — səhifəni yeniləyin.");
  }
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

function drawGlasses(left, right, pose) {
  if (!selected) return false;
  if (usesMeshVto()) {
    if (!meshReady()) {
      const png = glassesLayer();
      if (png && left && right) {
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= 8) {
          const angle = Math.atan2(dy, dx);
          const midX = (left.x + right.x) / 2;
          const midY = (left.y + right.y) / 2;
          const targetW = dist * (selected.scale ?? 1.18);
          const targetH = (png.height / png.width) * targetW;
          const nx = dx / dist;
          const ny = dy / dist;
          const py = nx;
          const cx = midX + nx * dist * (selected.offset_x || 0);
          const cy =
            midY + ny * dist * (selected.offset_x || 0) + py * dist * (selected.offset_y || 0);
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(angle);
          ctx.drawImage(png, -targetW / 2, -targetH / 2, targetW, targetH);
          ctx.restore();
          return true;
        }
      }
      return false;
    }
    overlay3d.resize(canvas.width, canvas.height);
    overlay3d.place(
      left,
      right,
      selected.mesh_scale ?? selected.scale,
      selected.offset_y || 0,
      pose || lastFacePose,
      canvas.width,
      canvas.height,
      selected,
    );
    overlay3d.render();
    if (!trackedTryon) {
      trackedTryon = true;
      track("tryon");
    }
    return true;
  }
  if (overlay3d && !selected.model_url) {
    overlay3d.resize(canvas.width, canvas.height);
    overlay3d.render();
  }
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
  const meshMode = meshReady();

  if (meshMode && overlay3d) {
    overlay3d.resize(w, h);
    overlay3d.setBackground(video, true);
    if (video.currentTime === lastVideoTime) {
      if (smooth) drawGlasses(smooth.left, smooth.right, lastFacePose);
      else overlay3d.render();
      return;
    }
    lastVideoTime = video.currentTime;
    const pose = engine.detectVideo(video, performance.now());
    if (!pose) {
      setStatus("Üzü kadra gətirin");
      overlay3d.render();
      return;
    }
    if (!meshLoadError) setStatus("");
    lastFacePose = pose;
    const eyes = poseToPixels(pose, w, h, true);
    smooth = smooth ? smoothPose(smooth, eyes) : eyes;
    drawGlasses(smooth.left, smooth.right, pose);
    return;
  }

  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();

  if (video.currentTime === lastVideoTime) {
    if (smooth) drawGlasses(smooth.left, smooth.right, lastFacePose);
    return;
  }
  lastVideoTime = video.currentTime;

  const pose = engine.detectVideo(video, performance.now());
  if (!pose) {
    setStatus("Üzü kadra gətirin");
    return;
  }
  setStatus("");
  lastFacePose = pose;
  const eyes = poseToPixels(pose, w, h, true);
  smooth = smooth ? smoothPose(smooth, eyes) : eyes;
  drawGlasses(smooth.left, smooth.right, pose);
}

async function startCamera() {
  setStatus("Kamera açılır…");
  await loadEngine();
  if (usesMeshVto()) {
    await sync3DModel();
    if (meshLoadError) {
      setStatus("3D eynək yüklənmədi — səhifəni yeniləyin və ya studio-dan yenidən VTO hazır edin.");
      setIdle(true);
      return;
    }
  }
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
  try {
    await video.play();
  } catch (err) {
    if (err && err.name === "AbortError") {
      await new Promise((r) => setTimeout(r, 80));
      await video.play();
    } else {
      throw err;
    }
  }
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
  const url = ((brandMeta && brandMeta.cart_url) || "").trim();
  if (!url) return;
  track("click");
  window.parent.postMessage({ type: "vto-add-to-cart", cart_url: url, brand: slug }, "*");
  if (mode === "embed") return;
  location.href = url;
}

async function renderPhoto() {
  if (!photoBitmap || !engine) return;
  canvas.width = photoBitmap.width;
  canvas.height = photoBitmap.height;
  if (meshReady() && overlay3d) {
    overlay3d.resize(canvas.width, canvas.height);
    overlay3d.setBackground(photoBitmap, false);
  } else {
    ctx.drawImage(photoBitmap, 0, 0);
  }
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
  lastFacePose = pose;
  const eyes = poseToPixels(pose, canvas.width, canvas.height, false);
  const ok = drawGlasses(eyes.left, eyes.right, pose);
  setStatus(ok ? "" : "Eynək şəkli hələ yüklənməyib, yenidən yoxlayın.");
}

async function tryPhoto(file) {
  setStatus("Şəkil hazırlanır…");
  stopCamera();
  engine = null;
  await loadEngine(true);
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
void ensureTryonConfig().catch(() => {});
if (mode === "embed") document.documentElement.classList.add("embed-mode");
if (mode !== "embed" && closeBtn) closeBtn.hidden = true;
