(() => {
  const btn = document.querySelector(".auglio-tryon-btn");
  const statusEl = document.querySelector("[data-vto-status]");
  const errorEl = document.querySelector("[data-vto-error]");
  const cfg = window.AUGLIO || {};
  const apiKey = typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";
  const itemId = typeof cfg.itemId === "string" ? cfg.itemId.trim() : "";

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

  function buttonVisible() {
    if (!btn) return false;
    const display = window.getComputedStyle(btn).display;
    return display !== "none";
  }

  if (!btn) return;

  if (itemId) {
    btn.setAttribute("data-item_id", itemId);
  }

  if (!apiKey) {
    btn.style.display = "flex";
    btn.disabled = true;
    setStatus("");
    setError(
      "Auglio açarı yoxdur. auglio.com-da trial açın, Dashboard → Integration → Get Code, sonra Render → Environment → AUGLIO_API_KEY.",
    );
    return;
  }

  if (!itemId) {
    btn.style.display = "flex";
    btn.disabled = true;
    setStatus("");
    setError("Bu eynəyin Auglio ITEM_ID-si yoxdur.");
    return;
  }

  const script = document.createElement("script");
  script.src = `https://m.auglio.com/${encodeURIComponent(apiKey)}`;
  script.async = true;
  script.onerror = () => {
    btn.style.display = "flex";
    btn.disabled = true;
    setError("Auglio skripti yüklənmədi. Açarı və interneti yoxlayın.");
  };
  document.body.appendChild(script);

  setStatus("Auglio məhsulu yoxlayır… Düymə uyğun tapılanda görünəcək.");

  window.setTimeout(() => {
    if (buttonVisible()) {
      setStatus("Üzümdə yoxla — Auglio canlı kamera açılacaq.");
      return;
    }
    setError(
      `Bu eynək Auglio-da tapılmadı. Dashboard-da NEW PRODUCT → ID mütləq ${itemId} olsun, və ya XML feed: /shop/auglio-feed.xml`,
    );
  }, 10000);
})();
