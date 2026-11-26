/**
 * Off-main-thread MediaPipe Face Landmarker worker.
 * Keeps UI & Three.js rendering at 60 FPS while tracking runs asynchronously.
 */
const MODULE = "/static/vendor/mediapipe/vision_bundle.mjs";
const WASM_BASE = "/static/vendor/mediapipe/wasm";
const MODEL_URL = "/static/vendor/mediapipe/face_landmarker.task";

let landmarker = null;
let mode = "VIDEO";

function toFace(result) {
  const landmarks = result && result.faceLandmarks && result.faceLandmarks[0];
  if (!landmarks) return null;
  const m = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
  return { landmarks, matrix: m && m.data ? Array.from(m.data) : null };
}

async function init() {
  const mp = await import(MODULE);
  const vision = await mp.FilesetResolver.forVisionTasks(WASM_BASE);
  const build = (delegate) =>
    mp.FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.4,
      minFacePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
  try {
    landmarker = await build("GPU");
  } catch {
    landmarker = await build("CPU");
  }
}

async function setMode(next) {
  if (next === mode) return;
  await landmarker.setOptions({ runningMode: next });
  mode = next;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  const { id, type, bitmap, timestampMs } = msg;
  try {
    if (type === "init") {
      await init();
      self.postMessage({ id, ok: true });
      return;
    }
    if (!landmarker || !bitmap) {
      self.postMessage({ id, face: null });
      return;
    }
    if (type === "video") {
      await setMode("VIDEO");
      const face = toFace(landmarker.detectForVideo(bitmap, timestampMs));
      self.postMessage({ id, face });
    } else if (type === "image") {
      await setMode("IMAGE");
      const face = toFace(landmarker.detect(bitmap));
      self.postMessage({ id, face });
    }
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
};
