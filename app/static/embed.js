import { createFaceTracker } from "./sdk/face-tracker.js?v=1";
import { createTryOn } from "./sdk/vto-core.js?v=3";

const params = new URLSearchParams(location.search);
const store = params.get("store") || params.get("brand") || "demo";
const embedded = window.parent !== window;
const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("canvas");
const stage = $("stage");
const panel = $("panel");

const vto = createTryOn(canvas);
const manifests = new Map();
let products = [];
let current = null;
let tracker = null;
let trackerPromise = null;
let stream = null;
let mode = "idle";
let loopId = 0;

function post(type, extra = {}) {
  if (embedded) window.parent.postMessage({ source: "eynek-vto", type, store, sku: current && current.sku, ...extra }, "*");
}

function showPanel(text, { busy = false, actions = false } = {}) {
  panel.hidden = false;
  $("panelText").textContent = text;
  $("spinner").hidden = !busy;
  $("panelActions").hidden = !actions;
}

function hidePanel() {
  panel.hidden = true;
}

let hintTimer = 0;
function hint(text) {
  const el = $("hint");
  clearTimeout(hintTimer);
  if (!text) {
    hintTimer = setTimeout(() => (el.hidden = true), 250);
    return;
  }
  el.textContent = text;
  el.hidden = false;
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Yüklənmədi.");
  return res.json();
}

async function manifestFor(sku) {
  if (!manifests.has(sku)) manifests.set(sku, api(`/v1/stores/${encodeURIComponent(store)}/products/${encodeURIComponent(sku)}`));
  return manifests.get(sku);
}

function renderStrip() {
  const strip = $("strip");
  strip.innerHTML = "";
  if (products.length < 2) return;
  for (const p of products) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "thumb" + (current && p.sku === current.sku ? " active" : "");
    b.title = p.name;
    b.style.backgroundImage = `url("${p.thumb}")`;
    b.addEventListener("click", () => selectProduct(p.sku));
    strip.appendChild(b);
  }
}

async function selectProduct(sku) {
  const m = await manifestFor(sku);
  await vto.setProduct(m);
  current = m;
  $("productName").textContent = m.name || m.sku;
  const s = m.sizes || {};
  $("productMeta").textContent = [s.lens, s.bridge, s.temple].every(Boolean) ? `${s.lens}-${s.bridge}-${s.temple}` : "";
  renderStrip();
  post("product-change");
  if (mode === "photo") redrawPhoto();
}

function ensureTracker() {
  if (!trackerPromise) {
    trackerPromise = createFaceTracker().then((t) => (tracker = t));
    trackerPromise.catch(() => (trackerPromise = null));
  }
  return trackerPromise;
}

function stopCamera() {
  cancelAnimationFrame(loopId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

function cameraError(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Kameraya icazə verilmədi. Brauzerdə icazə verin və ya selfi yükləyin.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Kamera tapılmadı. Selfi yükləyə bilərsiniz.";
  if (name === "NotReadableError") return "Kamera başqa proqram tərəfindən istifadə olunur.";
  return (err && err.message) || "Kamera açılmadı.";
}

async function startCamera() {
  showPanel("Kamera açılır…", { busy: true });
  try {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Bu brauzer kameranı dəstəkləmir.");
    const [s] = await Promise.all([
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      }),
      ensureTracker(),
    ]);
    stream = s;
    video.srcObject = stream;
    await video.play().catch((err) => {
      if (err.name !== "AbortError") throw err;
    });
    if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
    mode = "live";
    stage.classList.remove("contain");
    vto.resize(video.videoWidth, video.videoHeight);
    vto.setSource(video, { mirror: true });
    vto.startLive();
    $("camBtn").hidden = true;
    hidePanel();
    loop();
  } catch (err) {
    stopCamera();
    mode = "idle";
    showPanel(cameraError(err), { actions: true });
  }
}

let lastVideoTime = -1;
let lastFaceAt = 0;
async function loop() {
  loopId = requestAnimationFrame(loop);
  if (mode !== "live" || !tracker || video.readyState < 2) return;
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const face = await tracker.detectVideo(video, now);
    vto.update(face, now);
    if (face) lastFaceAt = now;
    hint(now - lastFaceAt > 900 ? "Üzünüzü kadra gətirin" : "");
  }
  vto.render();
}

let photoCanvas = null;
let photoFace = null;
async function usePhoto(file) {
  if (!file) return;
  stopCamera();
  showPanel("Şəkil analiz olunur…", { busy: true });
  try {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    photoCanvas = document.createElement("canvas");
    photoCanvas.width = Math.round(img.naturalWidth * scale);
    photoCanvas.height = Math.round(img.naturalHeight * scale);
    photoCanvas.getContext("2d").drawImage(img, 0, 0, photoCanvas.width, photoCanvas.height);
    URL.revokeObjectURL(img.src);
    await ensureTracker();
    photoFace = await tracker.detectImage(photoCanvas);
    if (!photoFace) throw new Error("Şəkildə üz tapılmadı. Öndən, işıqlı selfi seçin.");
    mode = "photo";
    stage.classList.add("contain");
    vto.resize(photoCanvas.width, photoCanvas.height);
    vto.setSource(photoCanvas, { mirror: false });
    vto.startLive();
    redrawPhoto();
    $("camBtn").hidden = false;
    hidePanel();
  } catch (err) {
    showPanel(err.message || "Şəkil açılmadı.", { actions: true });
  }
}

function redrawPhoto() {
  if (!photoFace) return;
  vto.startLive();
  for (let i = 0; i < 4; i += 1) vto.update(photoFace, performance.now() + i * 33);
  vto.render();
}

async function takeShot() {
  if (mode === "idle") return;
  const url = vto.snapshot();
  post("snapshot", { image: url });
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(current && current.sku) || "eynek"}-tryon.jpg`;
  a.click();
}

function bind() {
  $("closeBtn").hidden = !embedded;
  $("cartBtn").hidden = !embedded || params.get("cart") === "0";
  $("closeBtn").addEventListener("click", () => {
    stopCamera();
    post("close");
  });
  $("cartBtn").addEventListener("click", () => post("add-to-cart"));
  $("shotBtn").addEventListener("click", takeShot);
  $("camBtn").addEventListener("click", startCamera);
  $("retryCam").addEventListener("click", startCamera);
  for (const id of ["photoInput", "photoInputPanel"]) {
    $(id).addEventListener("change", (e) => usePhoto(e.target.files && e.target.files[0]));
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && embedded) {
      stopCamera();
      post("close");
    }
  });
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "eynek-vto:set-product" && e.data.sku) selectProduct(e.data.sku).catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && mode === "live") {
      stopCamera();
      mode = "idle";
      showPanel("Kamera dayandırıldı.", { actions: true });
    }
  });
}

async function boot() {
  bind();
  showPanel("Eynək hazırlanır…", { busy: true });
  ensureTracker().catch(() => {});
  try {
    const list = await api(`/v1/stores/${encodeURIComponent(store)}/products`);
    products = list.products || [];
    const sku = params.get("sku") || params.get("variant-id") || (products[0] && products[0].sku);
    if (!sku) throw new Error("Bu mağazada hələ VTO məhsulu yoxdur.");
    await selectProduct(sku);
  } catch (err) {
    showPanel(err.message || "Məhsul yüklənmədi.");
    post("error", { message: err.message });
    return;
  }
  post("ready");
  const face = params.get("face");
  if (face) {
    const blob = await (await fetch(face)).blob();
    return usePhoto(blob);
  }
  startCamera();
}

boot();
