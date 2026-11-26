/**
 * MediaPipe Face Landmarker, self-hosted (CDNs are often blocked in AZ).
 * Runs in a dedicated ES module Web Worker when supported (keeping WebGL & UI smooth),
 * with automatic main-thread fallback on browsers without module workers.
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

async function createWorkerTracker() {
  if (typeof Worker === "undefined" || typeof createImageBitmap === "undefined") {
    throw new Error("no-worker");
  }
  const worker = new Worker(new URL("./face-worker.js?v=1", import.meta.url), { type: "module" });
  const pending = new Map();
  let seq = 1;
  let videoBusy = false;
  let lastFace = null;

  const call = (payload, transfer = []) =>
    new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...payload, id }, transfer);
    });

  worker.onmessage = (e) => {
    const { id, error, ...rest } = e.data || {};
    const slot = pending.get(id);
    if (!slot) return;
    pending.delete(id);
    if (error) slot.reject(new Error(error));
    else slot.resolve(rest);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || "worker-error");
    pending.forEach((s) => s.reject(err));
    pending.clear();
  };

  try {
    await withTimeout(call({ type: "init" }), 10000);
  } catch (err) {
    worker.terminate();
    throw err;
  }

  return {
    offThread: true,
    async detectVideo(video, timestampMs) {
      if (videoBusy) return lastFace;
      videoBusy = true;
      try {
        const bitmap = await createImageBitmap(video);
        const { face } = await call({ type: "video", bitmap, timestampMs }, [bitmap]);
        lastFace = face;
        return face;
      } catch {
        return lastFace;
      } finally {
        videoBusy = false;
      }
    },
    async detectImage(image) {
      const bitmap = await createImageBitmap(image);
      const { face } = await call({ type: "image", bitmap }, [bitmap]);
      return face;
    },
  };
}

async function createMainThreadTracker() {
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
    offThread: false,
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

export async function createFaceTracker() {
  try {
    return await createWorkerTracker();
  } catch {
    return createMainThreadTracker();
  }
}
