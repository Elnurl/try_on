const photoInput = document.querySelector("#photo");
const framesEl = document.querySelector("#frames");
const statusEl = document.querySelector("#status");
const sourceImg = document.querySelector("#source");
const resultImg = document.querySelector("#result");
const sourceEmpty = document.querySelector("#source-empty");
const resultEmpty = document.querySelector("#result-empty");

let selectedSku = null;
let currentFile = null;

function setStatus(message) {
  if (!statusEl) return;
  statusEl.hidden = !message;
  statusEl.textContent = message || "";
}

function showSource(file) {
  if (!sourceImg) return;
  sourceImg.src = URL.createObjectURL(file);
  sourceImg.hidden = false;
  if (sourceEmpty) sourceEmpty.hidden = true;
}

function renderFrames(items) {
  framesEl.innerHTML = "";
  items.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "frame" + (index === 0 ? " active" : "");
    btn.innerHTML = `<img alt="" src="${item.image_url}" /><span>${item.name_az}</span>`;
    btn.addEventListener("click", () => {
      selectedSku = item.id;
      framesEl.querySelectorAll(".frame").forEach((el) => el.classList.remove("active"));
      btn.classList.add("active");
      if (currentFile) runTryon();
    });
    framesEl.appendChild(btn);
    if (index === 0) selectedSku = item.id;
  });
}

async function runTryon() {
  if (!currentFile || !selectedSku) return;
  setStatus("Overlay hazırlanır…");
  const body = new FormData();
  body.append("image", currentFile);
  body.append("sku", selectedSku);
  const res = await fetch("/api/tryon", { method: "POST", body });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Xəta" }));
    setStatus(err.detail || "Try-on alınmadı");
    return;
  }
  const blob = await res.blob();
  resultImg.src = URL.createObjectURL(blob);
  resultImg.hidden = false;
  if (resultEmpty) resultEmpty.hidden = true;
  setStatus("");
}

function useFile(file) {
  if (!file) return;
  currentFile = file;
  showSource(file);
  runTryon();
}

if (photoInput) {
  photoInput.addEventListener("change", () => {
    const file = photoInput.files && photoInput.files[0];
    useFile(file);
  });
}

fetch("/api/frames")
  .then((res) => res.json())
  .then(renderFrames)
  .catch(() => setStatus("Kataloq yüklənmədi. Server işləyirmi?"));
