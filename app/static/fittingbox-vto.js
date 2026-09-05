(() => {
  const CONTAINER_ID = "fitmix-container";
  const INIT_ERROR =
    "Virtual Try-On yüklənmədi. Browser-i yeniləyib yenidən cəhd edin.";
  const MISSING_KEY_ERROR =
    "Canlı kamera üçün Fittingbox açarı Render-də yoxdur. vto-test/.env.local içindəki NEXT_PUBLIC_FITTINGBOX_API_KEY dəyərini Render → Environment → FITTINGBOX_API_KEY kimi yapışdırın.";
  const CAMERA_ERROR =
    "Kamera icazəsi verilmədi. Virtual Try-On üçün kamera icazəsi lazımdır.";

  const cfg = window.FITTINGBOX || {};
  const apiKey = cfg.apiKey || "";
  const frameId = cfg.frameId || "";
  const destinationUrl = cfg.destinationUrl || "";

  const startBtn = document.querySelector("[data-start-vto]");
  const statusEl = document.querySelector("[data-vto-status]");
  const errorEl = document.querySelector("[data-vto-error]");
  const overlay = document.getElementById("vto-overlay");
  const closeBtn = document.querySelector("[data-stop-vto]");
  const standardFrame = document.getElementById("vto-standard-frame");
  const container = document.getElementById(CONTAINER_ID);

  if (!startBtn) return;

  let instance = null;
  let ready = false;
  let userClosing = false;

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

  function showOverlay() {
    if (!overlay) return;
    overlay.style.visibility = "visible";
    overlay.setAttribute("aria-hidden", "false");
  }

  function hideOverlay() {
    if (!overlay) return;
    overlay.style.visibility = "hidden";
    overlay.setAttribute("aria-hidden", "true");
    startBtn.disabled = !ready && !destinationUrl;
  }

  function allowCameraOnIframe(root) {
    if (!root) return;
    const iframe = root.querySelector("iframe");
    if (!iframe) return;
    iframe.setAttribute("allow", "camera; microphone; autoplay");
    iframe.setAttribute("allowfullscreen", "true");
  }

  function hasActiveIssue(data) {
    return Object.values(data || {}).some(Boolean);
  }

  function handleIssue(data) {
    if (!hasActiveIssue(data)) return;
    console.warn("[Fittingbox] onIssue", data);
    if (data.cameraAccessDenied || data.noCameraFound) {
      setError(CAMERA_ERROR);
      return;
    }
    if (data.liveIncompatibleBrowser || data.liveIncompatibleOS) {
      setError(
        "Virtual Try-On bu browser və ya əməliyyat sistemi ilə uyğun deyil.",
      );
      return;
    }
    if (
      data.licenseNotFound ||
      data.frameNotFound ||
      data.serverNotResponding ||
      data.protocolFailed
    ) {
      setError(INIT_ERROR);
    }
  }

  function initStandard() {
    if (!standardFrame || !overlay) {
      setError(INIT_ERROR);
      return;
    }
    standardFrame.hidden = false;
    standardFrame.src = destinationUrl;
    if (container) container.hidden = true;
    startBtn.disabled = false;
    setStatus("Üzümdə yoxla — canlı kamera açılacaq.");
    startBtn.addEventListener("click", () => {
      setError("");
      showOverlay();
    });
    closeBtn?.addEventListener("click", () => {
      hideOverlay();
    });
  }

  function initAdvanced() {
    if (!apiKey) {
      setError(MISSING_KEY_ERROR);
      setStatus("");
      startBtn.disabled = true;
      return;
    }
    if (!window.FitMix || !container) {
      setError(INIT_ERROR);
      setStatus("");
      startBtn.disabled = true;
      return;
    }
    if (standardFrame) standardFrame.hidden = true;
    setStatus("Canlı kamera hazırlanır…");
    const observer = new MutationObserver(() => allowCameraOnIframe(container));
    observer.observe(container, { childList: true, subtree: true });

    instance = window.FitMix.createWidget(
      CONTAINER_ID,
      {
        apiKey,
        frame: frameId,
        width: 400,
        height: 640,
        popupIntegration: {
          centeredHorizontal: true,
          centeredVertical: true,
          width: 400,
          height: 640,
        },
        uiConfiguration: {
          cameraPermissionScreen: true,
          liveCameraAccessDenied: true,
          vtoLoadingScreen: true,
        },
        onIssue: handleIssue,
        onOpenStream: (value) => {
          if (!value.success) setError(CAMERA_ERROR);
        },
        onStopVto: () => {
          if (userClosing) {
            userClosing = false;
            hideOverlay();
          }
        },
      },
      () => {
        if (frameId) instance.setFrame(frameId);
        allowCameraOnIframe(container);
        ready = true;
        startBtn.disabled = false;
        setStatus("Üzümdə yoxla — canlı kamera açılacaq.");
      },
    );

    startBtn.addEventListener("click", () => {
      setError("");
      userClosing = false;
      if (!ready || !instance) {
        setError(INIT_ERROR);
        return;
      }
      allowCameraOnIframe(container);
      if (frameId) instance.setFrame(frameId);
      instance.startVto("live");
    });

    closeBtn?.addEventListener("click", () => {
      userClosing = true;
      if (!instance) {
        hideOverlay();
        return;
      }
      instance.stopVto();
    });
  }

  if (destinationUrl) {
    initStandard();
    return;
  }
  initAdvanced();
})();
