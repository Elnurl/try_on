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

  function popupSize() {
    const widthPx = Math.max(
      400,
      Math.round(Math.min(window.innerWidth * 0.72, window.innerWidth - 32)),
    );
    const heightPx = Math.max(
      480,
      Math.round(Math.min(window.innerHeight * 0.82, window.innerHeight - 32)),
    );
    return { width: `${widthPx}px`, height: `${heightPx}px` };
  }

  function resetPrivacy() {
    if (widget && typeof widget.resetDisclaimer === "function") {
      widget.resetDisclaimer();
    }
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

  const size = popupSize();

  widget = window.FitMix.createWidget(
    "fitmix-container",
    {
      apiKey,
      frame: frameId,
      lang: "en",
      popupIntegration: {
        centeredHorizontal: true,
        centeredVertical: true,
        width: size.width,
        height: size.height,
      },
      uiConfiguration: {
        cameraPermissionScreen: true,
        liveCameraAccessDenied: true,
        vtoLoadingScreen: true,
        loadingIndicator: true,
      },
      onPrivacyTermsShown: () => {
        setStatus("Şərtlər açıldı. I agree düyməsinə basın.");
      },
      onAgreePrivacyTerms: () => {
        setStatus("Şərtlər qəbul edildi. Kamera açılacaq.");
      },
      onDisagreePrivacyTerms: () => {
        document.body.classList.remove("vto-open");
        startBtn.disabled = false;
        setStatus("Şərtlər qəbul edilmədi. Yenidən Üzümdə yoxla basın.");
      },
      onOpenStream: (value) => {
        if (value && value.success) {
          setStatus("Kamera açıqdır.");
        }
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
      resetPrivacy();
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
    resetPrivacy();
    document.body.classList.add("vto-open");
    setStatus("Pəncərə açılır. Ağ şərtlər ekranını gözləyin.");
    if (frameId) widget.setFrame(frameId);
    widget.startVto("live");
  });
})();
