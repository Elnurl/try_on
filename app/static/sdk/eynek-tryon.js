/**
 * EYNƏK Try-On Engine — sizin SDK.
 *
 * Üz izləmə: MediaPipe Face Landmarker (Apache 2.0)
 * 3D: three.js (MIT)
 * Bu fayl sizindir: Bakı satıcılarına widget/SDK kimi sata bilərsiniz.
 *
 * İstifadə:
 *   const vto = await EynekTryOn.create({ container });
 *   await vto.start();
 *   vto.setFrame({ style: "rectangle", color: 0x111111 });
 *   vto.stop();
 */
import * as THREE from "three";

const MP_MODULE = "/static/vendor/mediapipe/vision_bundle.mjs";
const MP_WASM = "/static/vendor/mediapipe/wasm";
const MP_MODEL = "/static/vendor/mediapipe/face_landmarker.task";

const LEFT_OUTER = 33;
const LEFT_INNER = 133;
const RIGHT_INNER = 362;
const RIGHT_OUTER = 263;

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.min(r, w / 2, h / 2);
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

function makeRim(w, h, r, thick, depth, color) {
  const outer = roundedRect(w, h, r);
  const hole = roundedRect(w - thick * 2, h - thick * 2, Math.max(0.04, r - thick));
  hole.curves.reverse();
  outer.holes.push(hole);
  const geom = new THREE.ExtrudeGeometry(outer, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.03,
    bevelSegments: 1,
  });
  geom.center();
  return new THREE.Mesh(
    geom,
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.35,
      metalness: 0.15,
    }),
  );
}

function makeLens(w, h, r, tint) {
  const geom = new THREE.ShapeGeometry(roundedRect(w - 0.18, h - 0.18, Math.max(0.02, r - 0.08)));
  return new THREE.Mesh(
    geom,
    new THREE.MeshPhysicalMaterial({
      color: tint,
      transparent: true,
      opacity: 0.42,
      roughness: 0.08,
      metalness: 0,
      transmission: 0.15,
      side: THREE.DoubleSide,
    }),
  );
}

export function buildFrame({ style = "rectangle", color = 0x151515, lens = 0x1a1a1a } = {}) {
  const group = new THREE.Group();
  group.name = `eynek-${style}`;

  const specs = {
    rectangle: { w: 5.2, h: 3.5, r: 0.28, gap: 1.55 },
    wayfarer: { w: 5.4, h: 3.7, r: 0.18, gap: 1.45 },
    aviator: { w: 5.5, h: 3.9, r: 1.7, gap: 1.35 },
    round: { w: 4.8, h: 4.8, r: 2.4, gap: 1.5 },
  }[style] || { w: 5.2, h: 3.5, r: 0.28, gap: 1.55 };

  const thick = 0.38;
  const depth = 0.42;
  const leftX = -(specs.w / 2 + specs.gap / 2);
  const rightX = specs.w / 2 + specs.gap / 2;

  const leftRim = makeRim(specs.w, specs.h, specs.r, thick, depth, color);
  leftRim.position.set(leftX, 0, 0);
  const rightRim = makeRim(specs.w, specs.h, specs.r, thick, depth, color);
  rightRim.position.set(rightX, 0, 0);
  group.add(leftRim, rightRim);

  const leftLens = makeLens(specs.w, specs.h, specs.r, lens);
  leftLens.position.set(leftX, 0, 0.02);
  const rightLens = makeLens(specs.w, specs.h, specs.r, lens);
  rightLens.position.set(rightX, 0, 0.02);
  group.add(leftLens, rightLens);

  const bridge = new THREE.Mesh(
    new THREE.BoxGeometry(specs.gap + 0.15, 0.28, 0.28),
    new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.15 }),
  );
  bridge.position.set(0, 0.35, 0);
  group.add(bridge);

  const templeMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.12 });
  const templeLen = 12.2;
  const hingeY = 0.15;
  const hingeX = specs.w + specs.gap / 2 - 0.1;

  const leftTemple = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, templeLen), templeMat);
  leftTemple.position.set(-hingeX, hingeY, -templeLen / 2 + 0.2);
  leftTemple.rotation.y = 0.06;
  const rightTemple = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, templeLen), templeMat);
  rightTemple.position.set(hingeX, hingeY, -templeLen / 2 + 0.2);
  rightTemple.rotation.y = -0.06;
  group.add(leftTemple, rightTemple);

  const bend = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.22, 2.2), templeMat);
  const lb = bend.clone();
  lb.position.set(-hingeX - 0.15, -0.15, -templeLen + 0.6);
  lb.rotation.x = 0.45;
  const rb = bend.clone();
  rb.position.set(hingeX + 0.15, -0.15, -templeLen + 0.6);
  rb.rotation.x = 0.45;
  group.add(lb, rb);

  return group;
}

function makeOccluder() {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(8.2, 24, 18),
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  mesh.renderOrder = -1;
  mesh.scale.set(1, 1.15, 0.85);
  mesh.position.set(0, -1.2, -1.5);
  return mesh;
}

function eyePose(result) {
  const lm = result.faceLandmarks && result.faceLandmarks[0];
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

async function createLandmarker() {
  const mp = await import(MP_MODULE);
  const vision = await mp.FilesetResolver.forVisionTasks(MP_WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MP_MODEL, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  try {
    return await mp.FaceLandmarker.createFromOptions(vision, opts("GPU"));
  } catch (err) {
    console.warn("[EynekTryOn] GPU delegate failed, using CPU", err);
    return mp.FaceLandmarker.createFromOptions(vision, opts("CPU"));
  }
}

export const EynekTryOn = {
  async create({ container, style = "rectangle", color = 0x151515 } = {}) {
    const host = typeof container === "string" ? document.querySelector(container) : container;
    if (!host) throw new Error("EynekTryOn: container tapılmadı");

    host.innerHTML = "";
    host.style.position = "relative";
    host.style.overflow = "hidden";
    host.style.background = "#111";

    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.setAttribute("playsinline", "");
    Object.assign(video.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "cover",
      transform: "scaleX(-1)",
    });

    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      transform: "scaleX(-1)",
    });
    host.append(video, canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    camera.position.set(0, 0, 40);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(-4, 6, 18);
    scene.add(key);

    const head = new THREE.Group();
    const occluder = makeOccluder();
    let glasses = buildFrame({ style, color });
    glasses.position.set(0, 1.1, 7.4);
    glasses.scale.setScalar(0.92);
    head.add(occluder, glasses);
    scene.add(head);

    let landmarker = null;
    let stream = null;
    let raf = 0;
    let lastVideoTime = -1;
    let smooth = null;

    function resize() {
      const w = host.clientWidth || 360;
      const h = host.clientHeight || 480;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    function lerpPose(a, b, t) {
      if (!a) return b;
      return {
        left: { x: a.left.x + (b.left.x - a.left.x) * t, y: a.left.y + (b.left.y - a.left.y) * t },
        right: { x: a.right.x + (b.right.x - a.right.x) * t, y: a.right.y + (b.right.y - a.right.y) * t },
      };
    }

    function placeFromEyes(pose, vw, vh) {
      const dx = pose.right.x - pose.left.x;
      const dy = pose.right.y - pose.left.y;
      const dist = Math.hypot(dx * vw, dy * vh);
      if (dist < 8) return;
      const midX = (pose.left.x + pose.right.x) / 2;
      const midY = (pose.left.y + pose.right.y) / 2;
      const nx = (midX - 0.5) * 16;
      const ny = (0.5 - midY) * 16 * (vh / vw);
      head.position.set(nx, ny + 0.35, 0);
      head.rotation.z = -Math.atan2(dy, dx);
      const s = Math.min(1.45, Math.max(0.7, dist / 170));
      head.scale.setScalar(s);
    }

    function placeFromMatrix(matrixData) {
      const m = new THREE.Matrix4().fromArray(matrixData);
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      m.decompose(pos, quat, scl);
      head.position.copy(pos.multiplyScalar(0.12));
      head.quaternion.copy(quat);
      const s = (scl.x + scl.y + scl.z) / 3;
      head.scale.setScalar(Math.min(1.6, Math.max(0.55, s * 0.12)));
    }

    function loop() {
      raf = requestAnimationFrame(loop);
      if (!video.videoWidth || !landmarker) return;
      resize();
      if (video.currentTime === lastVideoTime) {
        renderer.render(scene, camera);
        return;
      }
      lastVideoTime = video.currentTime;
      const result = landmarker.detectForVideo(video, performance.now());
      const matrix = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
      if (matrix && matrix.data) {
        placeFromMatrix(matrix.data);
      } else {
        const pose = eyePose(result);
        if (!pose) {
          renderer.render(scene, camera);
          return;
        }
        smooth = lerpPose(smooth, pose, 0.35);
        placeFromEyes(smooth, video.videoWidth, video.videoHeight);
      }
      renderer.render(scene, camera);
    }

    return {
      async start() {
        landmarker = await createLandmarker();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        video.srcObject = stream;
        await video.play();
        resize();
        loop();
      },
      setFrame(next = {}) {
        head.remove(glasses);
        glasses.traverse((child) => {
          if (child.geometry) child.geometry.dispose();
        });
        glasses = buildFrame({
          style: next.style || style,
          color: next.color ?? color,
          lens: next.lens,
        });
        glasses.position.set(0, 1.1, 7.4);
        glasses.scale.setScalar(0.92);
        head.add(glasses);
      },
      stop() {
        cancelAnimationFrame(raf);
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = null;
        video.srcObject = null;
      },
    };
  },
};

window.EynekTryOn = EynekTryOn;
