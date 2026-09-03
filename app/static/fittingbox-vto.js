(() => {
  const SCRIPT_URL =
    "https://vto-advanced-integration-api.fittingbox.com/index.js";
  const CONTAINER_ID = "fitmix-container";
  const INIT_ERROR =
    "Virtual Try-On yüklənmədi. Browser-i yeniləyib yenidən cəhd edin.";
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

  if (!startBtn || !overlay) return;

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

  function allowCameraOnIframe(container) {
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

  function loadLibrary() {
    if (window.FitMix) return Promise.resolve(window.FitMix);
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${SCRIPT_URL}"]`);
      const finish = () => {
        if (window.FitMix) resolve(window.FitMix);
        else reject(new Error("FitMix global is missing after script load"));
      };
      if (existing) {
        const started = Date.now();
        const poll = window.setInterval(() => {
          if (window.FitMix) {
            window.clearInterval(poll);
            resolve(window.FitMix);
            return;
          }
          if (Date.now() - started > 15000) {
            window.clearInterval(poll);
            reject(new Error("FitMix did not initialize"));
          }
        }, 50);
        existing.addEventListener(
          "error",
          () => {
            window.clearInterval(poll);
            reject(new Error("Fittingbox script failed to load"));
          },
          { once: true },
        );
        return;
      }
      const script = document.createElement("script");
      script.src = SCRIPT_URL;
      script.type = "text/javascript";
      script.async = false;
      script.defer = false;
      script.onload = finish;
      script.onerror = () =>
        reject(new Error("Fittingbox script failed to load"));
      document.head.appendChild(script);
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

  function showOverlay() {
    overlay.style.visibility = "visible";
    overlay.setAttribute("aria-hidden", "false");
  }

  function hideOverlay() {
    overlay.style.visibility = "hidden";
    overlay.setAttribute("aria-hidden", "true");
    starting = false;
    if (waitEl) waitEl.hidden = true;
    startBtn.disabled = !ready;
  }

  async function startVto() {
    setError("");
    userClosing = false;
    if (!ready || !instance) {
      setError(INIT_ERROR);
      return;
    }
    showOverlay();
    const container = document.getElementById(CONTAINER_ID);
    if (container) allowCameraOnIframe(container);
    starting = true;
    startBtn.disabled = true;
    if (waitEl) waitEl.hidden = false;
    const granted = await requestPageCameraAccess();
    if (!granted) {
      console.info(
        "[Fittingbox] Parent getUserMedia did not grant; Fittingbox will ask again in the iframe.",
      );
    }
    try {
      instance.setFrame(frameId);
      instance.startVto("live");
      console.info("[Fittingbox] startVto('live') from user click");
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
      console.info("[Fittingbox] stopVto()");
    } catch (err) {
      console.error("[Fittingbox] stopVto failed", err);
      hideOverlay();
    }
  }

  async function initWidget() {
    if (!apiKey) {
      setError(INIT_ERROR);
      setStatus("");
      startBtn.disabled = true;
      console.error("[Fittingbox] API key is missing.");
      return;
    }
    setStatus("Virtual Try-On hazırlanır…");
    const container = document.getElementById(CONTAINER_ID);
    if (!container) {
      setError(INIT_ERROR);
      return;
    }
    const observer = new MutationObserver(() => allowCameraOnIframe(container));
    observer.observe(container, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => {
      if (!ready) {
        console.error("[Fittingbox] Widget did not become ready in time");
        setError(INIT_ERROR);
        setStatus("");
      }
    }, 20000);
    try {
      const FitMix = await loadLibrary();
      instance = FitMix.createWidget(
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
          onOpenStream: (value) => {
            console.info("[Fittingbox] onOpenStream", value);
            starting = false;
            if (waitEl) waitEl.hidden = true;
            if (!value.success) setError(CAMERA_ERROR);
          },
          onPrivacyTermsShown: () => {
            console.info(
              "[Fittingbox] Privacy terms shown — Agree düyməsini basın, sonra brauzer kamera icazəsi çıxacaq.",
            );
          },
          onAgreePrivacyTerms: () => {
            console.info("[Fittingbox] Privacy terms accepted");
          },
          onStopVto: () => {
            console.info("[Fittingbox] onStopVto — camera released");
            starting = false;
            if (waitEl) waitEl.hidden = true;
            if (userClosing) {
              userClosing = false;
              hideOverlay();
            }
          },
        },
        () => {
          instance.setFrame(frameId);
          allowCameraOnIframe(container);
          ready = true;
          window.clearTimeout(timeout);
          startBtn.disabled = false;
          setStatus("");
          console.info("[Fittingbox] Widget ready. Frame set:", frameId);
        },
      );
    } catch (err) {
      console.error("[Fittingbox] Initialization failed", err);
      window.clearTimeout(timeout);
      setError(INIT_ERROR);
      setStatus("");
    }
  }

  startBtn.addEventListener("click", () => {
    void startVto();
  });
  closeBtn?.addEventListener("click", stopVto);
  void initWidget();
})();
