(() => {
  const startBtn = document.querySelector("[data-start-vto]");
  const statusEl = document.querySelector("[data-vto-status]");
  const errorEl = document.querySelector("[data-vto-error]");
  const cfg = window.FITTINGBOX || {};
  const apiKey = cfg.apiKey || "";
  const frameId = cfg.frameId || "";

  if (!startBtn) return;

  let widget = null;
  let ready = false;

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

  if (!apiKey) {
    setError(
      "Fittingbox açarı yoxdur. Render → Environment → FITTINGBOX_API_KEY.",
    );
    startBtn.disabled = true;
    return;
  }

  if (!window.FitMix) {
    setError("Fittingbox skripti yüklənmədi. Səhifəni yeniləyin.");
    startBtn.disabled = true;
    return;
  }

  widget = window.FitMix.createWidget(
    "fitmix-container",
    {
      apiKey,
      frame: frameId,
      popupIntegration: {
        centeredHorizontal: true,
        centeredVertical: true,
        width: "400px",
        height: "640px",
      },
      onIssue: (data) => {
        if (!data || !Object.values(data).some(Boolean)) return;
        if (data.cameraAccessDenied || data.noCameraFound) {
          setError("Kamera icazəsi verilmədi.");
        } else if (data.licenseNotFound) {
          setError("Fittingbox lisenziyası bu domen üçün keçərli deyil.");
        } else if (data.frameNotFound) {
          setError("Bu eynək Fittingbox kataloqunda tapılmadı.");
        }
      },
      onStopVto: () => {
        document.body.classList.remove("vto-open");
        startBtn.disabled = false;
        setStatus("Üzümdə yoxla — canlı kamera açılacaq.");
      },
    },
    () => {
      ready = true;
      if (frameId) widget.setFrame(frameId);
      startBtn.disabled = false;
      setStatus("Üzümdə yoxla — canlı kamera açılacaq.");
    },
  );

  startBtn.addEventListener("click", () => {
    if (!ready || !widget) {
      setError("Virtual Try-On hələ hazır deyil. 3 saniyə gözləyib yenidən basın.");
      return;
    }
    setError("");
    document.body.classList.add("vto-open");
    setStatus("Pəncərə açıldı. Ortada narıncı çərçivəyə baxın.");
    if (frameId) widget.setFrame(frameId);
    widget.startVto("live");
  });
})();
