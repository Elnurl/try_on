import { createTryOn } from "./sdk/vto-core.js?v=1";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const KEY_STORAGE = "eynek-vto-key";
const files = { front: null, left: null, right: null };
let me = null;
let preview = null;
let previewLoop = 0;

function authHeaders() {
  if (token) return { "X-Upload-Token": token };
  const key = localStorage.getItem(KEY_STORAGE);
  return key ? { "X-Api-Key": key } : {};
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(typeof data.detail === "string" ? data.detail : "Xəta baş verdi.");
    err.status = res.status;
    throw err;
  }
  return data;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function login() {
  try {
    me = await api("/v1/me");
  } catch (err) {
    if (!token) localStorage.removeItem(KEY_STORAGE);
    $("authCard").hidden = token !== "";
    $("authError").textContent = authHeaders()["X-Api-Key"] || token ? err.message : "";
    if (token) $("who").textContent = err.message;
    return;
  }
  $("authCard").hidden = true;
  $("app").hidden = false;
  $("who").innerHTML = `${escapeHtml(me.name || me.store)}${me.seller ? ` · ${escapeHtml(me.seller)}` : ""}${
    token ? "" : ' · <a href="#" id="logout">çıxış</a>'
  }`;
  const out = $("logout");
  if (out)
    out.addEventListener("click", (e) => {
      e.preventDefault();
      localStorage.removeItem(KEY_STORAGE);
      location.reload();
    });
  loadList();
}

function setDrop(slot, file) {
  files[slot] = file;
  const el = document.querySelector(`.drop[data-slot="${slot}"]`);
  if (el.dataset.url) URL.revokeObjectURL(el.dataset.url);
  if (file) {
    el.dataset.url = URL.createObjectURL(file);
    el.style.backgroundImage = `url("${el.dataset.url}")`;
    el.classList.add("filled");
  } else {
    el.style.backgroundImage = "";
    el.classList.remove("filled");
  }
}

function bindDrops() {
  document.querySelectorAll(".drop").forEach((el) => {
    const slot = el.dataset.slot;
    const input = el.querySelector("input");
    input.addEventListener("change", () => setDrop(slot, input.files[0] || null));
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.classList.add("dragover");
    });
    el.addEventListener("dragleave", () => el.classList.remove("dragover"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("dragover");
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) setDrop(slot, f);
    });
  });
}

function stat(label, value) {
  return `<div class="stat"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`;
}

async function showResult(m) {
  $("resultCard").hidden = false;
  $("resultTitle").textContent = `${m.name || m.sku} — hazırdır`;
  $("texture").src = m.texture;
  const lenses = m.lenses || [];
  const widthNote = { lens: "linzadan ölçüldü", given: "daxil edildi", sizes: "ölçülərdən", default: "standart" }[m.widthSource] || "";
  $("stats").innerHTML = [
    stat(`Çərçivə eni (${widthNote})`, `${Math.round(m.widthMm)} mm`),
    stat("Linzalar", lenses.length === 2 ? (lenses.every((l) => l.clear) ? "2 · şəffaf" : "2 · rəngli") : `${lenses.length} tapıldı`),
    stat("Qol uzunluğu", `${Math.round((m.temple && m.temple.lengthMm) || 145)} mm`),
    stat("Qol rəngi", (m.temple && m.temple.color) || "—"),
  ].join("");
  if (lenses.length !== 2) {
    $("stats").insertAdjacentHTML(
      "beforeend",
      '<div class="stat" style="grid-column:1/-1"><span>Linzalar tam tapılmadı. Daha təmiz, düz öndən ağ fonda şəkil yükləsəniz nəticə yaxşılaşar.</span></div>',
    );
  }
  $("code").hidden = true;
  $("tryBtn").onclick = () => window.EynekVTO && window.EynekVTO.open({ store: m.store, sku: m.sku, cart: false });
  $("codeBtn").onclick = () => {
    $("code").hidden = !$("code").hidden;
    $("code").textContent = [
      `<script src="${location.origin}/sdk/eynek-vto.js" data-store="${m.store}" async></script>`,
      "",
      `<button data-eynek-vto="${m.sku}" data-eynek-hide-missing>Üzündə yoxla</button>`,
    ].join("\n");
  };
  if (!preview) {
    preview = createTryOn($("preview3d"));
    preview.startPreview();
  }
  const canvas = $("preview3d");
  const w = canvas.clientWidth || 480;
  preview.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  preview.resize(w, Math.round((w * 3) / 4));
  await preview.setProduct(m);
  cancelAnimationFrame(previewLoop);
  const tick = (t) => {
    previewLoop = requestAnimationFrame(tick);
    preview.render(t);
  };
  previewLoop = requestAnimationFrame(tick);
  $("resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function submit(e) {
  e.preventDefault();
  $("uploadError").textContent = "";
  if (!files.front) {
    $("uploadError").textContent = "Ön şəkil mütləqdir.";
    return;
  }
  const body = new FormData();
  body.append("sku", $("sku").value.trim());
  body.append("name", $("name").value.trim());
  body.append("sizes", $("sizes").value.trim());
  if ($("widthMm").value) body.append("width_mm", $("widthMm").value);
  for (const [slot, f] of Object.entries(files)) if (f) body.append(slot, f);
  $("submitBtn").disabled = true;
  $("progress").textContent = "Şəkillər emal olunur: fon silinir, linzalar tapılır… (10-40 san)";
  try {
    const m = await api("/v1/products", { method: "POST", body });
    $("progress").textContent = "";
    await showResult(m);
    loadList();
  } catch (err) {
    $("progress").textContent = "";
    $("uploadError").textContent = err.message;
  } finally {
    $("submitBtn").disabled = false;
  }
}

async function loadList() {
  const data = await api("/v1/products").catch(() => ({ products: [] }));
  const list = $("list");
  list.innerHTML = "";
  $("emptyList").hidden = data.products.length > 0;
  for (const m of data.products) {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<img src="${escapeHtml(m.thumb)}" alt="" loading="lazy" />
      <div><b>${escapeHtml(m.name || m.sku)}</b><div class="muted">${escapeHtml(m.sku)} · ${Math.round(m.widthMm)} mm</div></div>
      <div class="actions">
        <button class="btn small" data-act="try">Yoxla</button>
        <button class="btn small ghost" data-act="view">Bax</button>
        <button class="btn small danger" data-act="del">Sil</button>
      </div>`;
    el.querySelector('[data-act="try"]').onclick = () => window.EynekVTO.open({ store: m.store, sku: m.sku, cart: false });
    el.querySelector('[data-act="view"]').onclick = () => showResult(m);
    el.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`${m.sku} silinsin?`)) return;
      await api(`/v1/products/${encodeURIComponent(m.sku)}`, { method: "DELETE" }).catch((err) => alert(err.message));
      loadList();
    };
    list.appendChild(el);
  }
}

$("authForm").addEventListener("submit", (e) => {
  e.preventDefault();
  localStorage.setItem(KEY_STORAGE, $("apiKey").value.trim());
  login();
});
$("uploadForm").addEventListener("submit", submit);
bindDrops();
if (!token && !localStorage.getItem(KEY_STORAGE)) $("authCard").hidden = false;
else login();
