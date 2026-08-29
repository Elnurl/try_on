/**
 * Try-on engine adapter (unified interface).
 *
 * The rest of the app only talks to this interface:
 *   engine = await createTryonEngine()
 *   await engine.setMode("VIDEO" | "IMAGE")
 *   pose = engine.detectVideo(videoEl, timestampMs)  // or detectImage(bitmap)
 *   pose = { left: {x, y}, right: {x, y} } in NORMALIZED [0..1] coords, or null.
 *
 * Swapping MediaPipe for DeepAR / GlassOn / Fittingbox later means rewriting
 * ONLY this file — live.js, catalogs, and the admin panel stay untouched.
 */
// Served from THIS origin — never jsDelivr/Google from the user's browser
// (those CDNs are often blocked in Azerbaijan).
const MODULE = "/static/vendor/mediapipe/vision_bundle.mjs";
const WASM_BASE = "/static/vendor/mediapipe/wasm";
const MODEL_URL = "/static/vendor/mediapipe/face_landmarker.task";

// Eye corner landmarks: midpoint of outer+inner corner ≈ pupil center.
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

export async function createTryonEngine() {
  // Dynamic import: if the CDN is unreachable, only try-on fails —
  // the catalog UI (which doesn't need the engine) keeps working.
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
