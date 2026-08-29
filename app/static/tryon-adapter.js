/**
 * Try-on engine adapter.
 *
 * Overlay (MediaPipe + 2D PNG) and DeepAR (3D glasses) share one factory:
 *   const engine = await createTryonEngine({ config, preview })
 *
 * DeepAR owns the camera/canvas. Overlay returns pose for live.js to draw.
 */
const MODULE = "/static/vendor/mediapipe/vision_bundle.mjs";
const WASM_BASE = "/static/vendor/mediapipe/wasm";
const MODEL_URL = "/static/vendor/mediapipe/face_landmarker.task";
const DEEPAR_MODULE = "/static/vendor/deepar/js/deepar.esm.js";

const LEFT_OUTER = 33;
const LEFT_INNER = 133;
const RIGHT_INNER = 362;
const RIGHT_OUTER = 263;

function toPose(result) {
  const lm = result && result.faceLandmarks && result.faceLandmarks[0];
  if (!lm) return null;
  return {
    left: {
      x: (lm[LEFT_OUTER].x + lm[LEFT_INNER].x) / 2,
      y: (lm[LEFT_OUTER].y + lm[LEFT_INNER].y) / 2,
    },
    right: {
      x: (lm[RIGHT_OUTER].x + lm[RIGHT_INNER].x) / 2,
      y: (lm[RIGHT_OUTER].y + lm[RIGHT_INNER].y) / 2,
    },
  };
}

async function build(mp, delegate) {
  const vision = await mp.FilesetResolver.forVisionTasks(WASM_BASE);
  return mp.FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
}

async function createOverlayEngine() {
  let mp;
  try {
    mp = await import(MODULE);
  } catch (err) {
    throw new Error("AR modulu yüklənmədi. Səhifəni yeniləyin — əgər yenə olmasa, adminə yazın.");
  }
  let landmarker;
  try {
    landmarker = await build(mp, "GPU");
  } catch (err) {
    console.warn("GPU delegate failed, falling back to CPU", err);
    landmarker = await build(mp, "CPU");
  }
  let mode = "VIDEO";
  return {
    kind: "overlay",
    name: "mediapipe-facelandmarker",
    async setMode(next) {
      if (next !== mode) {
        await landmarker.setOptions({ runningMode: next });
        mode = next;
      }
    },
    detectVideo(videoEl, timestampMs) {
      return toPose(landmarker.detectForVideo(videoEl, timestampMs));
    },
    detectImage(source) {
      return toPose(landmarker.detect(source));
    },
  };
}

async function createDeepAREngine({ config, preview }) {
  if (!preview) throw new Error("3D preview elementi tapılmadı.");
  let deepar;
  try {
    deepar = await import(DEEPAR_MODULE);
  } catch (err) {
    throw new Error("3D mühərrik faylı yüklənmədi. Səhifəni yeniləyin.");
  }
  const effect = config.defaultEffect;
  const dar = await deepar.initialize({
    licenseKey: config.licenseKey,
    previewElement: preview,
    rootPath: config.rootPath,
    effect,
    additionalOptions: {
      cameraConfig: { disableDefaultCamera: true },
    },
  });
  return {
    kind: "deepar",
    name: "deepar-web",
    async startLive() {
      await dar.startCamera();
    },
    async stopLive() {
      dar.stopCamera();
    },
    async setItem(item) {
      const url = (item && item.effect_url) || effect;
      await dar.switchEffect(url);
    },
    async showPhoto(imageEl) {
      dar.stopCamera();
      dar.processImage(imageEl);
    },
    async screenshot() {
      return dar.takeScreenshot();
    },
  };
}

export async function createTryonEngine(opts = {}) {
  const config = opts.config || {};
  if (config.engine === "deepar" && config.licenseKey) {
    return createDeepAREngine({ config, preview: opts.preview });
  }
  return createOverlayEngine();
}
