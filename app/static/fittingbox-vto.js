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
  let observer = null;

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

  function allowCameraOnce() {
    const iframe = container.querySelector("iframe");
    if (!iframe) return false;
    const allow = iframe.getAttribute("allow") || "";
    if (!allow.includes("camera")) {
      iframe.setAttribute("allow", "camera; microphone; autoplay");
    }
    if (!iframe.hasAttribute("allowfullscreen")) {
      iframe.setAttribute("allowfullscreen", "true");
    }
    return true;
  }

  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function resetWidget() {
    observer?.disconnect();
    observer = null;
    try {
      instance?.remove?.();
    } catch {
      /* Fittingbox may already have torn the iframe down */
    }
    instance = null;
    ready = false;
    container.replaceChildren();
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
    observer = new MutationObserver(() => {
      if (allowCameraOnce()) {
        observer?.disconnect();
        observer = null;
      }
    });
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
          startBtn.disabled = false;
          hideOverlay();
          resetWidget();
        },
      },
      () => {
        ready = true;
        if (frameId) widget.setFrame(frameId);
        allowCameraOnce();
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
    if (!apiKey) {
      setError(MISSING_KEY_ERROR);
      return;
    }
    starting = true;
    startBtn.disabled = true;
    showOverlay();
    await nextPaint();

    try {
      if (!instance) {
        instance = createWidget();
      }
      await waitUntilReady();
      await nextPaint();
      if (frameId) instance.setFrame(frameId);
      instance.startVto("live");
    } catch (err) {
      console.error("[Fittingbox] startVto failed", err);
      resetWidget();
      hideOverlay();
      setError(INIT_ERROR);
    }
  }

  function stopVto() {
    if (!instance) {
      hideOverlay();
      resetWidget();
      return;
    }
    try {
      instance.stopVto();
    } catch (err) {
      console.error("[Fittingbox] stopVto failed", err);
      hideOverlay();
      resetWidget();
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
