(() => {
  const btn = document.querySelector(".auglio-tryon-btn");
  const statusEl = document.querySelector("[data-vto-status]");
  const errorEl = document.querySelector("[data-vto-error]");
  const cfg = window.AUGLIO || {};
  const apiKey = typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";
  const itemId = typeof cfg.itemId === "string" ? cfg.itemId.trim() : "";
  const demoUrl =
    typeof cfg.demoUrl === "string" && cfg.demoUrl.trim()
      ? cfg.demoUrl.trim()
      : "https://auglio.com/en/demo-store/eyewear";

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
    return window.getComputedStyle(btn).display !== "none";
  }

  if (!btn) return;

  if (itemId) {
    btn.setAttribute("data-item_id", itemId);
  }

  if (!apiKey) {
    btn.style.display = "flex";
    btn.disabled = false;
    setError("");
    setStatus(
      "Açar gələndə sizin eynəklər açılacaq. İndi Auglio-nun rəsmi eynək demo-su açılır.",
    );
    btn.addEventListener("click", () => {
      window.location.href = demoUrl;
    });
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
    setError("Auglio skripti yüklənmədi. Açarı yoxlayın.");
  };
  document.body.appendChild(script);

  setStatus("Auglio məhsulu yoxlayır… Düymə uyğun tapılanda görünəcək.");

  window.setTimeout(() => {
    if (buttonVisible()) {
      setStatus("Üzümdə yoxla — Auglio canlı kamera və ya şəkil açılacaq.");
      return;
    }
    setError(
      `Bu eynək Auglio-da tapılmadı. Alex-ə yazın: ITEM_ID ${itemId}, feed ${location.origin}/shop/auglio-feed.xml`,
    );
  }, 10000);
})();
