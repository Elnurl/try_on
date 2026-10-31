/**
 * MediaPipe Face Landmarker, self-hosted (CDNs are often blocked in AZ).
 * detect*() → { landmarks: [{x,y,z}] (normalised), matrix: number[16] | null }
 */
const MODULE = "/static/vendor/mediapipe/vision_bundle.mjs";
const WASM_BASE = "/static/vendor/mediapipe/wasm";
const MODEL_URL = "/static/vendor/mediapipe/face_landmarker.task";

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function toFace(result) {
  const landmarks = result && result.faceLandmarks && result.faceLandmarks[0];
  if (!landmarks) return null;
  const m = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
  return { landmarks, matrix: m && m.data ? Array.from(m.data) : null };
}

export async function createFaceTracker() {
  let mp;
  try {
    mp = await import(MODULE);
  } catch (err) {
    throw new Error("Üz izləmə modulu yüklənmədi. Səhifəni yeniləyin.");
  }
  const vision = await mp.FilesetResolver.forVisionTasks(WASM_BASE);
  const build = (delegate, runningMode) =>
    mp.FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode,
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.4,
      minFacePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
  let landmarker;
  try {
    landmarker = await withTimeout(build("GPU", "VIDEO"), 9000);
  } catch (err) {
    landmarker = await build("CPU", "VIDEO");
  }
  let mode = "VIDEO";
  async function setMode(next) {
    if (next === mode) return;
    await landmarker.setOptions({ runningMode: next });
    mode = next;
  }
  return {
    async detectVideo(video, timestampMs) {
      await setMode("VIDEO");
      return toFace(landmarker.detectForVideo(video, timestampMs));
    },
    async detectImage(image) {
      await setMode("IMAGE");
      return toFace(landmarker.detect(image));
    },
  };
}
