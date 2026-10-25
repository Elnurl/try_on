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
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
];

function pt(lm, i) {
  const p = lm[i];
  if (!p) return null;
  return { x: p.x, y: p.y, z: p.z || 0 };
}

function toPose(result) {
  const lm = result && result.faceLandmarks && result.faceLandmarks[0];
  if (!lm) return null;
  const left = pt(lm, LEFT_OUTER);
  const right = pt(lm, RIGHT_OUTER);
  const bridge = pt(lm, 168) || pt(lm, 6);
  const nose = pt(lm, 1);
  const eyeW = Math.hypot(right.x - left.x, right.y - left.y) || 1e-4;
  const midX = (left.x + right.x) / 2;
  const midY = (left.y + right.y) / 2;
  return {
    left,
    right,
    bridge: bridge || {
      x: ((lm[LEFT_INNER] && lm[LEFT_INNER].x) + (lm[RIGHT_INNER] && lm[RIGHT_INNER].x)) / 2,
      y: ((lm[LEFT_INNER] && lm[LEFT_INNER].y) + (lm[RIGHT_INNER] && lm[RIGHT_INNER].y)) / 2,
      z: 0,
    },
    nose,
    leftCheek: pt(lm, 234),
    rightCheek: pt(lm, 454),
    leftEar: pt(lm, 127) || pt(lm, 234),
    rightEar: pt(lm, 356) || pt(lm, 454),
    noseLeft: pt(lm, 48) || pt(lm, 64),
    noseRight: pt(lm, 278) || pt(lm, 294),
    contour: FACE_OVAL.map((i) => pt(lm, i)).filter(Boolean),
    roll: Math.atan2(right.y - left.y, right.x - left.x),
    yaw: Math.max(-1, Math.min(1, ((nose ? nose.x : midX) - midX) / eyeW * 2.1)),
    pitch: Math.max(-1, Math.min(1, ((nose ? nose.y : midY) - midY) / eyeW * 1.7)),
    matrix: (result.facialTransformationMatrixes
      && result.facialTransformationMatrixes[0]
      && result.facialTransformationMatrixes[0].data)
      ? Array.from(result.facialTransformationMatrixes[0].data)
      : null,
  };
}

async function build(mp, delegate) {
  const vision = await mp.FilesetResolver.forVisionTasks(WASM_BASE);
  return mp.FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFacialTransformationMatrixes: true,
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
  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error("landmarker timeout")), ms)),
    ]);
  try {
    landmarker = await withTimeout(build(mp, "GPU"), 8000);
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
  if (!opts.forceOverlay && config.engine === "deepar" && config.licenseKey) {
    return createDeepAREngine({ config, preview: opts.preview });
  }
  return createOverlayEngine();
}
