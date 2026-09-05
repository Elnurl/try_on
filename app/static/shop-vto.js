(() => {
  const startBtn = document.querySelector("[data-start-vto]");
  const fileInput = document.querySelector("[data-vto-file]");
  const statusEl = document.querySelector("[data-vto-status]");
  const errorEl = document.querySelector("[data-vto-error]");
  const artEl = document.querySelector("[data-vto-art]");
  const product = window.SHOP_PRODUCT;

  if (!startBtn || !fileInput || !product) return;

  function setError(message) {
    if (!errorEl) return;
    errorEl.hidden = !message;
    errorEl.textContent = message ? `Xəta baş verdi. ${message}` : "";
  }

  function setStatus(message) {
    if (!statusEl) return;
    statusEl.hidden = !message;
    statusEl.textContent = message || "";
  }

  function showResult(blob) {
    if (!artEl) return;
    const url = URL.createObjectURL(blob);
    artEl.innerHTML = `<img class="g-result" src="${url}" alt="Virtual try-on nəticəsi" />`;
  }

  async function checkConfig() {
    try {
      const res = await fetch("/api/vto/status");
      const data = await res.json();
      if (!data.configured) {
        startBtn.disabled = true;
        setError(
          "TryOnCloud açarı serverdə yoxdur. Render Dashboard → tryon-wa → Environment → TRYONCLOUD_API_KEY əlavə edin. Açar tryoncloud.com → Developer API bölməsindən götürülür.",
        );
        setStatus("");
        return;
      }
      startBtn.disabled = false;
      setError("");
    } catch {
      startBtn.disabled = true;
      setError("Serverə qoşulmaq mümkün olmadı.");
    }
  }

  async function runTryOn(file) {
    setError("");
    setStatus("Şəkil hazırlanır, 5–15 saniyə…");
    startBtn.disabled = true;
    const body = new FormData();
    body.append("product_id", product.id);
    body.append("photo", file, file.name || "selfie.jpg");
    try {
      const res = await fetch("/api/vto/try", { method: "POST", body });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Virtual try-on hazırlanmadı.");
      }
      const blob = await res.blob();
      if (!blob.type.startsWith("image/")) {
        throw new Error("Server şəkil qaytarmadı.");
      }
      showResult(blob);
      setStatus("Nəticə hazırdır. Bəyənməsəniz başqa şəkil yoxlayın.");
    } catch (err) {
      setError(err.message || "Virtual try-on hazırlanmadı.");
      setStatus("Selfie və ya üz şəkli seçin. Nəticə 5–15 saniyəyə hazır olur.");
    } finally {
      startBtn.disabled = false;
    }
  }

  startBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (file) void runTryOn(file);
  });

  void checkConfig();
})();
