import { strings, pickLang } from "./embed-i18n.js?v=1";
import { createFaceTracker } from "./sdk/face-tracker.js?v=1";
import { createTryOn } from "./sdk/vto-core.js?v=1";

const TERMS_VERSION = "1";
const TERMS_KEY = "eynek-vto:terms";
const INIT_WAIT_MS = 1500;
const CART_WAIT_MS = 4000;

const params = new URLSearchParams(location.search);
const store = params.get("store") || params.get("brand") || "demo";
const embedded = window.parent !== window;
const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("canvas");
const stage = $("stage");
const screenEl = $("screen");

const vto = createTryOn(canvas);
const manifests = new Map();
const info = new Map();
let T = strings(params.get("lang"));
let host = {};
let vtoProducts = [];
let strip = [];
let current = null;
let tracker = null;
let trackerPromise = null;
let stream = null;
let mode = "idle";
let loopId = 0;

function post(type, extra = {}) {
  if (embedded) window.parent.postMessage({ source: "eynek-vto", type, store, sku: current && current.sku, ...extra }, "*");
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

function icon(path, size = 28) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", size);
  el.setAttribute("height", size);
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  return el;
}
const ICON_CAMERA = "M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.2-2h6.6l1.2 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM12 16.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z";
const ICON_BLOCKED = "M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.2-2h6.6l1.2 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM4 4l16 16";
const ICON_INFO = "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01";

function showScreen(...children) {
  const body = h("div", { class: "screen-body" }, ...children);
  if (embedded) {
    const close = h("button", { type: "button", class: "icon-btn close-corner", "aria-label": T.close, onclick: closeWidget }, icon("M6 6l12 12M18 6L6 18", 20));
    screenEl.replaceChildren(close, body);
  } else {
    screenEl.replaceChildren(body);
  }
  screenEl.hidden = false;
}

function hideScreen() {
  screenEl.hidden = true;
  screenEl.replaceChildren();
}

function busy(text) {
  $("busy").hidden = !text;
  $("busyText").textContent = text || "";
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

function priceText(p) {
  if (!p) return "";
  if (p.priceText) return String(p.priceText);
  if (p.price == null || p.price === "") return "";
  const n = Number(p.price);
  return `${Number.isFinite(n) ? n.toFixed(Number.isInteger(n) ? 0 : 2) : p.price} ${p.currency || "AZN"}`;
}

/* ---------- loading ---------- */

let loadingBar = null;
let loadingStep = null;
function showLoading() {
  const pic = h("div", { class: "product-pic", id: "loadingPic" });
  const img = host.product && host.product.image;
  if (img) pic.style.backgroundImage = `url("${String(img).replace(/"/g, "%22")}")`;
  else pic.hidden = true;
  loadingBar = h("span");
  loadingStep = h("div", { class: "step" }, T.loadingProduct);
  showScreen(
    h("div", { class: "wordmark" }, "EYNƏK", h("i", {}, ".")),
    pic,
    h("div", { class: "eyebrow" }, T.title),
    h("div", { class: "progress" }, loadingBar),
    loadingStep,
  );
}

function progress(pct, step) {
  if (loadingBar) loadingBar.style.width = `${pct}%`;
  if (loadingStep && step) loadingStep.textContent = step;
}

/* ---------- terms ---------- */

function termsAccepted() {
  try {
    return localStorage.getItem(TERMS_KEY) === termsVersion();
  } catch {
    return false;
  }
}

function termsVersion() {
  return `${TERMS_VERSION}:${host.termsVersion || ""}`;
}

function askTerms() {
  return new Promise((resolve) => {
    const box = h("input", { type: "checkbox", id: "termsBox" });
    const go = h("button", { type: "button", class: "btn btn-full", disabled: true }, T.continue);
    box.addEventListener("change", () => (go.disabled = !box.checked));
    go.addEventListener("click", () => {
      try {
        localStorage.setItem(TERMS_KEY, termsVersion());
      } catch {
        /* storage blocked: ask again next time */
      }
      resolve();
    });
    const label = h("label", { class: "check", for: "termsBox" }, box, h("span", {}, T.termsAccept));
    if (host.termsUrl) {
      label.lastChild.append(" · ", h("a", { href: host.termsUrl, target: "_blank", rel: "noopener" }, T.termsLink));
    }
    showScreen(
      h("div", { class: "glyph" }, icon(ICON_INFO)),
      h("h2", {}, T.termsTitle),
      h("p", {}, T.termsLead),
      h("ul", { class: "points" }, (host.termsPoints || T.termsPoints).map((t) => h("li", {}, t))),
      label,
      go,
    );
  });
}

/* ---------- camera ---------- */

function photoButton(cls = "btn btn-secondary btn-full") {
  const input = h("input", { type: "file", accept: "image/*", hidden: true });
  input.addEventListener("change", () => usePhoto(input.files && input.files[0]));
  return h("label", { class: cls }, T.uploadPhoto, input);
}

function askCamera() {
  showScreen(
    h("div", { class: "glyph" }, icon(ICON_CAMERA)),
    h("h2", {}, T.camTitle),
    h("p", {}, T.camText),
    h("div", { class: "stack" }, h("button", { type: "button", class: "btn btn-full", onclick: startCamera }, T.camOpen), photoButton()),
  );
}

function platformSteps() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return T.deniedIos;
  if (/Android/.test(ua)) return T.deniedAndroid;
  return T.deniedDesktop;
}

function showDenied() {
  showScreen(
    h("div", { class: "glyph" }, icon(ICON_BLOCKED)),
    h("h2", {}, T.deniedTitle),
    h("p", {}, T.deniedText),
    h("ol", { class: "steps" }, platformSteps().map((s) => h("li", {}, s))),
    h("div", { class: "stack" }, h("button", { type: "button", class: "btn btn-full", onclick: startCamera }, T.retry), photoButton()),
  );
}

function showMessage(text, { retry = null, photo = true } = {}) {
  showScreen(
    h("div", { class: "glyph" }, icon(ICON_INFO)),
    h("p", { style: "color:var(--ink);font-size:14px" }, text),
    h(
      "div",
      { class: "stack" },
      retry ? h("button", { type: "button", class: "btn btn-full", onclick: retry }, T.retry) : null,
      photo && current ? photoButton() : null,
    ),
  );
}

async function cameraPermission() {
  try {
    const status = await navigator.permissions.query({ name: "camera" });
    return status.state;
  } catch {
    return "prompt";
  }
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

async function startCamera() {
  hideScreen();
  busy(T.camOpening);
  try {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error(T.camUnsupported), { name: "Unsupported" });
    const [s] = await Promise.all([
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }),
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
    busy("");
    loop();
  } catch (err) {
    stopCamera();
    mode = "idle";
    busy("");
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "SecurityError") showDenied();
    else if (name === "NotFoundError" || name === "OverconstrainedError") showMessage(T.noCamera);
    else if (name === "NotReadableError") showMessage(T.camBusy, { retry: startCamera });
    else if (name === "Unsupported") showMessage(T.camUnsupported);
    else showMessage(navigator.onLine === false ? T.offline : T.failed, { retry: startCamera });
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
    hint(now - lastFaceAt > 900 ? T.faceHint : "");
  }
  vto.render();
}

let photoFace = null;
async function usePhoto(file) {
  if (!file) return;
  stopCamera();
  hideScreen();
  busy(T.analyzing);
  try {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const photo = document.createElement("canvas");
    photo.width = Math.round(img.naturalWidth * scale);
    photo.height = Math.round(img.naturalHeight * scale);
    photo.getContext("2d").drawImage(img, 0, 0, photo.width, photo.height);
    URL.revokeObjectURL(img.src);
    await ensureTracker();
    photoFace = await tracker.detectImage(photo);
    if (!photoFace) throw new Error(T.noFace);
    mode = "photo";
    stage.classList.add("contain");
    vto.resize(photo.width, photo.height);
    vto.setSource(photo, { mirror: false });
    vto.startLive();
    redrawPhoto();
    $("camBtn").hidden = false;
    busy("");
  } catch (err) {
    busy("");
    showMessage(err.message || T.failed, { retry: mode === "idle" ? startCamera : null });
  }
}

function redrawPhoto() {
  if (!photoFace) return;
  vto.startLive();
  for (let i = 0; i < 4; i += 1) vto.update(photoFace, performance.now() + i * 33);
  vto.render();
}

/* ---------- products ---------- */

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).detail || T.failed), { status: res.status });
  return res.json();
}

function manifestFor(sku) {
  if (!manifests.has(sku)) {
    const p = api(`/v1/stores/${encodeURIComponent(store)}/products/${encodeURIComponent(sku)}`);
    p.catch(() => manifests.delete(sku));
    manifests.set(sku, p);
  }
  return manifests.get(sku);
}

function rememberInfo(p) {
  if (p && p.sku != null && p.sku !== "") info.set(String(p.sku), { ...(info.get(String(p.sku)) || {}), ...p, sku: String(p.sku) });
}

function renderHead() {
  const i = (current && info.get(current.sku)) || {};
  $("vendor").textContent = i.vendor || "";
  $("productName").textContent = i.name || (current && (current.name || current.sku)) || T.title;
  $("productPrice").textContent = priceText(i);
  const cart = $("cartBtn");
  const unavailable = i.available === false;
  cart.disabled = unavailable;
  const price = priceText(i);
  cart.textContent = unavailable ? T.outOfStock : price ? `${T.addToCart} · ${price}` : T.addToCart;
}

function renderStrip() {
  const wrap = $("stripWrap");
  const el = $("strip");
  el.replaceChildren();
  if (strip.length < 2) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  $("stripLabel").textContent = host.products ? T.similar : T.models;
  const thumbs = new Map(vtoProducts.map((p) => [p.sku, p.thumb]));
  for (const sku of strip) {
    const i = info.get(sku) || {};
    const pic = h("span", { class: "pic" });
    const thumb = thumbs.get(sku) || i.image;
    if (thumb) pic.style.backgroundImage = `url("${String(thumb).replace(/"/g, "%22")}")`;
    el.append(
      h(
        "button",
        { type: "button", class: "model" + (current && sku === current.sku ? " active" : ""), title: i.name || sku, onclick: () => selectProduct(sku) },
        pic,
        h("b", {}, i.name || sku),
        priceText(i) ? h("small", {}, priceText(i)) : null,
      ),
    );
  }
}

async function selectProduct(sku) {
  const m = await manifestFor(sku);
  await vto.setProduct(m);
  current = m;
  rememberInfo({ sku: m.sku, name: (info.get(m.sku) || {}).name || m.name });
  $("toast").hidden = true;
  renderHead();
  renderStrip();
  post("product-change");
  if (mode === "photo") redrawPhoto();
}

/* ---------- cart ---------- */

let cartWait = null;
function addToCart() {
  if (!current) return;
  const btn = $("cartBtn");
  btn.disabled = true;
  const done = (result) => {
    cartWait = null;
    btn.disabled = (info.get(current.sku) || {}).available === false;
    showToast(result && result.ok === false ? result.message || T.failed : T.added, !(result && result.ok === false));
  };
  const timer = setTimeout(() => done({ ok: true }), CART_WAIT_MS);
  cartWait = (result) => {
    clearTimeout(timer);
    done(result);
  };
  post("add-to-cart", { product: info.get(current.sku) || { sku: current.sku } });
}

let toastTimer = 0;
function showToast(text, ok = true) {
  $("toastText").textContent = text;
  $("viewCartBtn").hidden = !ok || host.viewCart === false;
  $("toast").classList.toggle("warn", !ok);
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6000);
}

/* ---------- host handshake ---------- */

function waitForInit() {
  if (!embedded) return Promise.resolve({});
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), INIT_WAIT_MS);
    window.addEventListener("message", function onInit(e) {
      if (e.source !== window.parent || !e.data || e.data.source !== "eynek-vto-host" || e.data.type !== "init") return;
      window.removeEventListener("message", onInit);
      clearTimeout(timer);
      resolve(e.data.config || {});
    });
    post("hello");
  });
}

function closeWidget() {
  stopCamera();
  post("close");
}

function applyStatic() {
  document.documentElement.lang = pickLang(host.lang || params.get("lang"));
  document.title = T.title;
  $("closeBtn").setAttribute("aria-label", T.close);
  $("selfieBtn").firstChild.textContent = T.selfie;
  $("camBtn").textContent = T.camera;
  $("shotBtn").textContent = T.snapshot;
  $("viewCartBtn").textContent = T.viewCart;
  $("closeBtn").hidden = !embedded;
  const cartOff = params.get("cart") === "0" || host.cart === false;
  $("cartBtn").hidden = !embedded || cartOff;
}

function bind() {
  $("closeBtn").addEventListener("click", closeWidget);
  $("cartBtn").addEventListener("click", addToCart);
  $("viewCartBtn").addEventListener("click", () => {
    stopCamera();
    post("view-cart");
  });
  $("shotBtn").addEventListener("click", () => {
    if (mode === "idle") return;
    const url = vto.snapshot();
    post("snapshot", { image: url });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(current && current.sku) || "eynek"}-tryon.jpg`;
    a.click();
  });
  $("camBtn").addEventListener("click", startCamera);
  $("photoInput").addEventListener("change", (e) => usePhoto(e.target.files && e.target.files[0]));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && embedded) closeWidget();
  });
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.source !== "eynek-vto-host") return;
    if (e.data.type === "cart-result" && cartWait) cartWait(e.data);
    if (e.data.type === "set-product" && e.data.sku) selectProduct(String(e.data.sku)).catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && mode === "live") {
      stopCamera();
      mode = "idle";
      showMessage(T.camStopped, { retry: startCamera });
    }
  });
}

async function boot() {
  bind();
  applyStatic();
  ensureTracker().catch(() => {});
  host = await waitForInit();
  T = strings(host.lang || params.get("lang"));
  applyStatic();
  showLoading();
  progress(15);
  const started = performance.now();

  let sku;
  let notice = "";
  try {
    const list = await api(`/v1/stores/${encodeURIComponent(store)}/products`);
    vtoProducts = list.products || [];
    for (const p of vtoProducts) rememberInfo({ sku: p.sku, name: p.name });
    rememberInfo(host.product);
    (host.products || []).forEach(rememberInfo);
    const ready = new Set(vtoProducts.map((p) => p.sku));
    const wanted = (host.product && host.product.sku) || params.get("sku") || params.get("variant-id") || "";
    const pool = host.products ? host.products.map((p) => String(p.sku)) : vtoProducts.map((p) => p.sku);
    strip = [...new Set([wanted, ...pool].filter((s) => s && ready.has(String(s))).map(String))];
    sku = wanted && ready.has(String(wanted)) ? String(wanted) : "";
    if (!sku) {
      const message = wanted ? T.noVto : T.noProducts;
      if (!strip.length) {
        showMessage(message, { photo: false });
        post("error", { message, code: wanted ? "no-vto" : "empty" });
        return;
      }
      sku = strip[0];
      notice = T.noVto;
    }
    progress(45, T.loadingProduct);
    const pic = document.getElementById("loadingPic");
    const thumb = (vtoProducts.find((p) => p.sku === sku) || {}).thumb;
    if (pic && pic.hidden && thumb) {
      pic.style.backgroundImage = `url("${thumb}")`;
      pic.hidden = false;
    }
    await selectProduct(sku);
  } catch (err) {
    const offline = navigator.onLine === false;
    showMessage(offline ? T.offline : err.status === 404 ? T.noVto : err.message || T.failed, { retry: () => location.reload(), photo: false });
    post("error", { message: err.message, code: offline ? "offline" : "load" });
    return;
  }

  progress(75, T.loadingFace);
  await Promise.race([ensureTracker().catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
  progress(100, T.loadingDone);
  await new Promise((r) => setTimeout(r, Math.max(250, 900 - (performance.now() - started))));
  post("ready");

  const preview = !embedded && params.get("screen");
  if (preview === "loading") {
    showLoading();
    requestAnimationFrame(() => progress(60, T.loadingFace));
    return;
  }
  if (preview === "camera") return askCamera();
  if (preview === "denied") return showDenied();
  if (!termsAccepted() || preview === "terms") await askTerms();
  if (notice) showToast(notice, false);
  const face = params.get("face");
  if (face) return usePhoto(await (await fetch(face)).blob());
  const permission = await cameraPermission();
  if (permission === "granted") startCamera();
  else if (permission === "denied") showDenied();
  else askCamera();
}

boot();
