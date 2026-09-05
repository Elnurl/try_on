(() => {
  const startBtn = document.querySelector("[data-start-vto]");
  const closeBtn = document.querySelector("[data-close-vto]");
  const layer = document.querySelector("#vto-layer");
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

  function setOpen(open) {
    document.body.classList.toggle("vto-open", open);
    if (layer) layer.setAttribute("aria-hidden", open ? "false" : "true");
    startBtn.disabled = open;
  }

  function allowCamera() {
    const iframe = document.querySelector("#fitmix-container iframe");
    if (!iframe) return;
    iframe.setAttribute("allow", "camera; microphone; autoplay; fullscreen");
    iframe.setAttribute("allowfullscreen", "true");
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
      lang: "en",
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
        setOpen(false);
        setStatus("Şərtlər qəbul edilmədi. Yenidən Üzümdə yoxla basın.");
      },
      onOpenStream: (value) => {
        if (value && value.success) {
          setStatus("Kamera açıqdır.");
        } else {
          setError("Kamera açıla bilmədi.");
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
        } else if (data.liveIncompatibleBrowser || data.liveIncompatibleOS) {
          setError("Bu brauzer Fittingbox canlı kamera ilə uyğun deyil.");
        } else if (data.serverNotResponding || data.protocolFailed) {
          setError("Fittingbox serverə qoşula bilmədi.");
        }
      },
      onStopVto: () => {
        setOpen(false);
        setStatus("Üzümdə yoxla — canlı kamera açılacaq.");
      },
    },
    (liveSupported) => {
      ready = true;
      allowCamera();
      if (frameId) widget.setFrame(frameId);
      if (typeof widget.resetDisclaimer === "function") {
        widget.resetDisclaimer();
      }
      startBtn.disabled = false;
      if (liveSupported === false) {
        setError("Fittingbox bu brauzerdə canlı kameranı dəstəkləmir.");
      } else {
        setStatus("Üzümdə yoxla — canlı kamera açılacaq.");
      }
    },
  );

  startBtn.addEventListener("click", () => {
    if (!ready || !widget) {
      setError("Virtual Try-On hələ hazır deyil. 3 saniyə gözləyib yenidən basın.");
      return;
    }
    setError("");
    setOpen(true);
    setStatus("Pəncərə açılır. Ağ şərtlər ekranını gözləyin.");
    allowCamera();
    if (frameId) widget.setFrame(frameId);
    widget.startVto("live");
  });

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      if (widget) widget.stopVto();
      setOpen(false);
    });
  }
})();
