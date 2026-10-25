import { createTryonEngine } from "./tryon-adapter.js?v=31";
import { createScene25, loadManifestGlasses } from "./sdk/eynek-25d.js?v=31";

const cam = document.querySelector("#cam");
const gl = document.querySelector("#gl");
const hidden = document.querySelector("#hidden2d");
const idleEl = document.querySelector("#idle");
const statusEl = document.querySelector("#status");
const preview = document.querySelector("#preview");
const widthInput = document.querySelector("#widthmm");
const stage = document.querySelector(".stage");

const DEMO = "/frames/ql2009-c1.png";

let engine = null;
let scene = createScene25(gl);
let manifest = null;
let faceImg = null;
let stream = null;
let raf = 0;
let mode = "idle";
let lastVideoTime = -1;
let enginePromise = null;

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function setIdle(show) {
  idleEl.hidden = !show;
}

function widthMm() {
  return Number(widthInput.value) || 140;
}

function opts(mirror) {
  return { mirror, widthMm: widthMm(), offsetY: 0.0 };
}

function stopLoop() {
  cancelAnimationFrame(raf);
  raf = 0;
}

function previewLoop() {
  raf = requestAnimationFrame(previewLoop);
  scene.spinPreview();
  scene.render();
}

function showDigital() {
  stopCam();
  stopLoop();
  mode = "preview";
  stage.classList.remove("is-live");
  stage.style.aspectRatio = "1 / 1";
  scene.resize(720, 720);
  scene.startPreview();
  setIdle(false);
  previewLoop();
}

function ensureEngine() {
  if (engine) return Promise.resolve(engine);
  if (enginePromise) return enginePromise;
  setStatus("Üz modeli yüklənir…");
  enginePromise = createTryonEngine({ config: { engine: "overlay" } })
    .then((e) => {
      engine = e;
      if ((statusEl.textContent || "").includes("yüklənir")) {
        setStatus("2.5D model hazırdır. Kameranı aç.");
      }
      return e;
    })
    .catch((err) => {
      enginePromise = null;
      throw err;
    });
  return enginePromise;
}

async function prepareFile(file) {
  setStatus("Şəkildən 2.5D asset yığılır…");
  const body = new FormData();
  body.append("photo", file);
  body.append("width_mm", String(widthMm()));
  const res = await fetch("/api/vto/prepare", { method: "POST", body });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Hazırlanmadı.");
  }
  return res.json();
}

async function applyManifest(next) {
  manifest = next;
  scene.setGlasses(await loadManifestGlasses(next));
  scene.reset();
  preview.src = next.texture;
  preview.classList.add("is-on");
  showDigital();
}

async function prepareUrl(url) {
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], "demo.png", { type: blob.type || "image/png" });
  await applyManifest(await prepareFile(file));
}

function drawPhoto(pose) {
  if (!pose) {
    setStatus("Üz tapılmadı. Öndən, işıqlı selfie yüklə.");
    return;
  }
  scene.stopPreview();
  scene.place(pose, faceImg.naturalWidth, faceImg.naturalHeight, opts(false));
  scene.render();
  setStatus("2.5D eynək üzə oturduldu.");
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (!cam.videoWidth || !engine) return;
  if (gl.width !== cam.videoWidth || gl.height !== cam.videoHeight) {
    scene.resize(cam.videoWidth, cam.videoHeight);
    scene.setBackground(cam, true);
  }
  if (cam.currentTime !== lastVideoTime) {
    lastVideoTime = cam.currentTime;
    const pose = engine.detectVideo(cam, performance.now());
    if (pose) {
      setStatus("");
      scene.place(pose, cam.videoWidth, cam.videoHeight, opts(true));
    } else {
      setStatus("Üzü kadra gətirin — öndən baxın");
    }
  }
  scene.render();
}

function camError(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Kamera icazəsi lazımdır. Ünvan çubuğundakı kilidə Allow seç.";
  }
  if (name === "NotFoundError") return "Kamera tapılmadı. Üz şəkli yüklə.";
  if (name === "NotReadableError") return "Kamera başqa proqramdadır.";
  return err.message || "Kamera açılmadı.";
}

function stopCam() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  cam.srcObject = null;
}

async function startCam() {
  try {
    if (!manifest) {
      setStatus("Demo eynək hazırlanır…");
      await prepareUrl(DEMO);
    }
    setStatus("Kamera açılır… Allow bas.");
    await ensureEngine();
    await engine.setMode("VIDEO");
    stopLoop();
    stopCam();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    cam.srcObject = stream;
    await cam.play();
    mode = "live";
    lastVideoTime = -1;
    scene.reset();
    scene.stopPreview();
    scene.resize(cam.videoWidth || 640, cam.videoHeight || 480);
    scene.setBackground(cam, true);
    stage.classList.add("is-live");
    stage.style.aspectRatio = `${cam.videoWidth} / ${cam.videoHeight}`;
    setIdle(false);
    loop();
  } catch (err) {
    setIdle(true);
    setStatus(camError(err));
  }
}

document.querySelector("#glasses").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    await applyManifest(await prepareFile(file));
    setStatus("2.5D model hazırdır — bu sənin eynək şəklindəndir. Kameranı aç.");
  } catch (err) {
    setStatus(err.message || "Hazırlanmadı.");
  }
});

document.querySelector("#face").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    if (!manifest) await prepareUrl(DEMO);
    stopLoop();
    stopCam();
    const url = URL.createObjectURL(file);
    faceImg = new Image();
    faceImg.src = url;
    await faceImg.decode();
    await ensureEngine();
    await engine.setMode("IMAGE");
    mode = "photo";
    hidden.width = faceImg.naturalWidth;
    hidden.height = faceImg.naturalHeight;
    hidden.getContext("2d").drawImage(faceImg, 0, 0);
    scene.reset();
    scene.stopPreview();
    scene.resize(faceImg.naturalWidth, faceImg.naturalHeight);
    scene.setBackground(hidden, false);
    stage.classList.remove("is-live");
    stage.style.aspectRatio = `${faceImg.naturalWidth} / ${faceImg.naturalHeight}`;
    setIdle(false);
    drawPhoto(engine.detectImage(faceImg));
  } catch (err) {
    setStatus(err.message || "Üz şəkli açılmadı.");
  }
});

document.querySelector("#live").addEventListener("click", () => startCam());

(async function boot() {
  try {
    await prepareUrl(DEMO);
    setStatus("2.5D model hazırdır. Kameranı aç, və ya öz eynək şəklini yüklə.");
    ensureEngine().catch(() => {});
  } catch (err) {
    setStatus("Eynək şəkli yüklə (ağ fon, düz ön).");
  }
})();
