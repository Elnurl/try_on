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
  let starting = false;
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
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
  }

  function hideOverlay() {
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    if (waitEl) waitEl.hidden = true;
    starting = false;
    startBtn.disabled = !apiKey;
  }

  function allowCameraOnIframe() {
    const iframe = container.querySelector("iframe");
    if (!iframe) return false;
    iframe.setAttribute("allow", "camera; microphone; autoplay");
    iframe.setAttribute("allowfullscreen", "true");
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.minHeight = "100%";
    iframe.style.border = "0";
    return true;
  }

  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
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

  function handleIssue(data) {
    if (!data || !Object.values(data).some(Boolean)) return;
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

  function createWidget() {
    if (!window.FitMix) {
      throw new Error("FitMix is missing");
    }
    const observer = new MutationObserver(allowCameraOnIframe);
    observer.observe(container, { childList: true, subtree: true });
    const widget = window.FitMix.createWidget(
      CONTAINER_ID,
      {
        apiKey,
        frame: frameId,
        uiConfiguration: {
          cameraPermissionScreen: true,
          liveCameraAccessDenied: true,
          vtoLoadingScreen: true,
        },
        onIssue: handleIssue,
        onPrivacyTermsShown: () => {
          if (waitEl) waitEl.hidden = false;
        },
        onAgreePrivacyTerms: () => {
          if (waitEl) waitEl.hidden = true;
        },
        onOpenStream: (value) => {
          starting = false;
          if (waitEl) waitEl.hidden = true;
          startBtn.disabled = false;
          if (!value.success) setError(CAMERA_ERROR);
        },
        onStopVto: () => {
          starting = false;
          if (waitEl) waitEl.hidden = true;
          startBtn.disabled = false;
          if (userClosing) {
            userClosing = false;
            hideOverlay();
          }
        },
      },
      () => {
        ready = true;
        if (frameId) widget.setFrame(frameId);
        allowCameraOnIframe();
      },
    );
    return widget;
  }

  function waitUntilReady() {
    if (ready && instance) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = window.setInterval(() => {
        if (ready && instance) {
          window.clearInterval(poll);
          resolve();
          return;
        }
        if (Date.now() - started > 20000) {
          window.clearInterval(poll);
          reject(new Error("Fittingbox ready timeout"));
        }
      }, 50);
    });
  }

  async function startVto() {
    setError("");
    userClosing = false;
    if (!apiKey) {
      setError(MISSING_KEY_ERROR);
      return;
    }
    starting = true;
    startBtn.disabled = true;
    showOverlay();
    await nextPaint();
    await requestPageCameraAccess();

    try {
      if (!instance) {
        instance = createWidget();
      }
      await waitUntilReady();
      await nextPaint();
      allowCameraOnIframe();
      if (frameId) instance.setFrame(frameId);
      instance.startVto("live");
    } catch (err) {
      console.error("[Fittingbox] startVto failed", err);
      starting = false;
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

  if (!apiKey) {
    setError(MISSING_KEY_ERROR);
    startBtn.disabled = true;
    setStatus("");
  } else if (!window.FitMix) {
    setError(INIT_ERROR);
    startBtn.disabled = true;
    setStatus("");
  } else {
    startBtn.disabled = false;
    setStatus("Üzümdə yoxla — canlı kamera açılacaq.");
  }

  startBtn.addEventListener("click", () => {
    if (starting) return;
    void startVto();
  });
  closeBtn?.addEventListener("click", stopVto);
})();
