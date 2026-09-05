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

  const startBtn = document.querySelector("[data-start-vto]");
  const statusEl = document.querySelector("[data-vto-status]");
  const errorEl = document.querySelector("[data-vto-error]");
  const overlay = document.getElementById("vto-overlay");
  const closeBtn = document.querySelector("[data-stop-vto]");
  const waitEl = document.querySelector("[data-vto-wait]");
  const container = document.getElementById(CONTAINER_ID);

  if (!startBtn || !overlay || !container) return;

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
    overlay.hidden = false;
    overlay.style.visibility = "visible";
    overlay.setAttribute("aria-hidden", "false");
  }

  function hideOverlay() {
    overlay.style.visibility = "hidden";
    overlay.setAttribute("aria-hidden", "true");
    if (waitEl) waitEl.hidden = true;
    startBtn.disabled = !ready;
  }

  function allowCameraOnIframe() {
    const iframe = container.querySelector("iframe");
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

  async function requestPageCameraAccess() {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch (err) {
      console.warn("[Fittingbox] page camera request failed", err);
      return false;
    }
  }

  async function startVto() {
    setError("");
    userClosing = false;
    if (!ready || !instance) {
      setError(INIT_ERROR);
      return;
    }
    showOverlay();
    allowCameraOnIframe();
    startBtn.disabled = true;
    if (waitEl) waitEl.hidden = false;
    await requestPageCameraAccess();
    try {
      if (frameId) instance.setFrame(frameId);
      instance.startVto("live");
    } catch (err) {
      console.error("[Fittingbox] startVto failed", err);
      hideOverlay();
      setError(INIT_ERROR);
    }
  }

  function stopVto() {
    userClosing = true;
    if (!instance) {
      hideOverlay();
      return;
    }
    try {
      instance.stopVto();
    } catch (err) {
      console.error("[Fittingbox] stopVto failed", err);
      hideOverlay();
    }
  }

  function initWidget() {
    if (!apiKey) {
      setError(MISSING_KEY_ERROR);
      setStatus("");
      startBtn.disabled = true;
      return;
    }
    if (!window.FitMix) {
      setError(INIT_ERROR);
      setStatus("");
      startBtn.disabled = true;
      return;
    }

    setStatus("Canlı kamera hazırlanır…");
    const observer = new MutationObserver(allowCameraOnIframe);
    observer.observe(container, { childList: true, subtree: true });

    instance = window.FitMix.createWidget(
      CONTAINER_ID,
      {
        apiKey,
        frame: frameId,
        width: 400,
        height: 640,
        uiConfiguration: {
          cameraPermissionScreen: true,
          liveCameraAccessDenied: true,
          vtoLoadingScreen: true,
        },
        onIssue: handleIssue,
        onOpenStream: (value) => {
          if (waitEl) waitEl.hidden = true;
          startBtn.disabled = false;
          if (!value.success) setError(CAMERA_ERROR);
        },
        onStopVto: () => {
          if (waitEl) waitEl.hidden = true;
          startBtn.disabled = false;
          if (userClosing) {
            userClosing = false;
            hideOverlay();
          }
        },
      },
      () => {
        if (frameId) instance.setFrame(frameId);
        allowCameraOnIframe();
        ready = true;
        startBtn.disabled = false;
        setStatus("Üzümdə yoxla — canlı kamera açılacaq.");
      },
    );
  }

  startBtn.addEventListener("click", () => {
    void startVto();
  });
  closeBtn?.addEventListener("click", stopVto);
  initWidget();
})();
