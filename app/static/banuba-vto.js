(() => {
  const btn = document.querySelector("[data-start-vto]");
  const statusEl = document.querySelector("[data-vto-status]");
  const errorEl = document.querySelector("[data-vto-error]");
  const cfg = window.BANUBA || {};
  const tryOnUrl = typeof cfg.tryOnUrl === "string" ? cfg.tryOnUrl.trim() : "";

  function setError(message) {
    if (!errorEl) return;
    errorEl.hidden = !message;
    errorEl.textContent = message || "";
  }

  function setStatus(message) {
    if (!statusEl) return;
    statusEl.hidden = !message;
    statusEl.textContent = message || "";
  }

  if (!btn) return;

  if (!tryOnUrl) {
    btn.disabled = true;
    setStatus("");
    setError(
      "Banuba linki hələ yoxdur. app.tintvto.com-da hesab aç, Glasses seç, eynək fotosu yüklə, try-on linkini kopyala. Sonra Render → Environment → BANUBA_TRYON_URL_RB_NEW_WAYFARER (və ya Aviator üçün BANUBA_TRYON_URL_RB_AVIATOR_CLASSIC).",
    );
    return;
  }

  btn.disabled = false;
  setError("");
  setStatus("Üzümdə yoxla — Banuba kameranı öz səhifəsində açacaq.");

  btn.addEventListener("click", () => {
    window.location.href = tryOnUrl;
  });
})();
