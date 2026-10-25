/**
 * Photo → 3D glasses + live mesh VTO (QL2009 GLB on face).
 */
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

function sampleRimColor(canvas) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 40))) {
    for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 40))) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 80) continue;
      const edge = x < w * 0.12 || x > w * 0.88 || y < h * 0.18 || y > h * 0.82;
      if (!edge) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
  }
  if (!n) return 0x1a1a1a;
  return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
}

function makeFrontTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function buildGlasses3D(cutoutCanvas) {
  const aspect = cutoutCanvas.height / cutoutCanvas.width;
  const rim = sampleRimColor(cutoutCanvas);
  const group = new THREE.Group();
  group.name = "digitized-glasses";

  const tex = makeFrontTexture(cutoutCanvas);
  const front = new THREE.Mesh(
    new THREE.PlaneGeometry(1, aspect),
    new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.12,
      roughness: 0.35,
      metalness: 0.08,
      side: THREE.DoubleSide,
    }),
  );
  front.position.z = 0.02;
  group.add(front);

  const templeMat = new THREE.MeshStandardMaterial({
    color: rim,
    roughness: 0.4,
    metalness: 0.1,
  });
  const templeGeom = new THREE.BoxGeometry(0.055, 0.032, 0.38);
  const left = new THREE.Mesh(templeGeom, templeMat);
  left.position.set(-0.5, aspect * 0.03, -0.18);
  left.rotation.y = 0.22;
  const right = new THREE.Mesh(templeGeom, templeMat);
  right.position.set(0.5, aspect * 0.03, -0.18);
  right.rotation.y = -0.22;
  group.add(left, right);

  group.userData.frameWidthCm = 14;
  group.userData.digitizedPhoto = true;
  return group;
}

export function exportGlb(object) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      object,
      (result) => resolve(new Blob([result], { type: "model/gltf-binary" })),
      reject,
      { binary: true },
    );
  });
}

const EYE_SPAN_MM = 92;
const MP_TO_THREE = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

function toVec(p, width, height, mirror) {
  if (!p) return null;
  return new THREE.Vector3(
    (mirror ? 1 - p.x : p.x) * width - width / 2,
    (0.5 - p.y) * height,
    -(p.z || 0) * width,
  );
}

function modelWidthCm(sizeX, frameWidthMm) {
  const target = (frameWidthMm || 127) / 10;
  if (sizeX > 15) return sizeX / 10;
  if (sizeX >= 0.5 && sizeX <= 3) return sizeX * target;
  if (sizeX > 0.15 && sizeX < 0.5) return target;
  return target;
}

function normalizeGlassesRoot(root, frameWidthMm) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);
  const targetCm = (frameWidthMm || 127) / 10;
  const currentCm = modelWidthCm(size.x, frameWidthMm);
  if (currentCm > 1e-6) {
    root.scale.multiplyScalar(targetCm / currentCm);
  }
  root.userData.frameWidthCm = targetCm;
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    child.renderOrder = 2;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat) => {
      mat.transparent = mat.transparent || mat.opacity < 1;
      mat.depthTest = true;
      mat.depthWrite = true;
      const name = (mat.name || child.name || "").toLowerCase();
      if (name.includes("lens")) {
        mat.transparent = true;
        mat.opacity = Math.min(mat.opacity || 1, 0.28);
        mat.depthWrite = false;
        mat.renderOrder = 3;
      }
    });
  });
}

export function createFaceOverlay3D(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = true;

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(-0.35, 0.65, 1);
  scene.add(key);

  const bgMat = new THREE.MeshBasicMaterial({ depthWrite: false });
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bgMat);
  bg.position.z = -200;
  bg.renderOrder = -3;
  scene.add(bg);

  const head = new THREE.Group();
  scene.add(head);

  const occluder = new THREE.Mesh(
    new THREE.SphereGeometry(1, 28, 20),
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  occluder.renderOrder = 0;
  occluder.position.set(0, -0.06, -0.58);
  occluder.scale.set(0.5, 0.76, 0.34);
  head.add(occluder);

  let camera = null;
  let glasses = null;
  let viewW = 1;
  let viewH = 1;
  let bgMirror = true;
  const loader = new GLTFLoader();
  const smooth = {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    scale: 1,
    ready: false,
  };

  function resize(width, height) {
    viewW = Math.max(2, width);
    viewH = Math.max(2, height);
    renderer.setSize(viewW, viewH, false);
    camera = new THREE.OrthographicCamera(
      -viewW / 2,
      viewW / 2,
      viewH / 2,
      -viewH / 2,
      0.1,
      4000,
    );
    camera.position.z = 800;
    bg.scale.set(viewW, viewH, 1);
  }

  function setBackground(source, mirror = true) {
    if (!source) return;
    bgMirror = mirror;
    if (bgMat.map) bgMat.map.dispose();
    const tex = source.play
      ? new THREE.VideoTexture(source)
      : new THREE.CanvasTexture(source);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    if (mirror) {
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.x = -1;
      tex.offset.x = 1;
    } else {
      tex.repeat.set(1, 1);
      tex.offset.set(0, 0);
    }
    bgMat.map = tex;
    bgMat.needsUpdate = true;
  }

  function clearGlasses() {
    if (!glasses) return;
    head.remove(glasses);
    glasses.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
          if (mat.map) mat.map.dispose();
          mat.dispose();
        });
      }
    });
    glasses = null;
    smooth.ready = false;
  }

  function isDigitizedPhotoMesh(root) {
    if (!root) return false;
    if (root.name === "digitized-glasses" || root.userData?.digitizedPhoto) return true;
    let tagged = false;
    root.traverse((child) => {
      if (child.userData?.digitizedPhoto) tagged = true;
    });
    if (tagged) return true;
    const box = new THREE.Box3().setFromObject(root);
    const sx = box.getSize(new THREE.Vector3()).x;
    return sx > 0.4 && sx < 1.35;
  }

  function setObject(object, meta = {}) {
    clearGlasses();
    glasses = object;
    const frameMm = meta.frameWidthMm || 140;
    if (isDigitizedPhotoMesh(glasses)) {
      const targetCm = frameMm / 10;
      glasses.userData.frameWidthCm = targetCm;
      glasses.userData.photoPlaneUnits = 1;
      const box = new THREE.Box3().setFromObject(glasses);
      const sx = box.getSize(new THREE.Vector3()).x || 1;
      if (sx < targetCm * 0.85) {
        glasses.scale.multiplyScalar(targetCm / sx);
      }
    } else {
      normalizeGlassesRoot(glasses, frameMm);
    }
    head.add(glasses);
  }

  async function loadUrl(url, meta = {}) {
    const gltf = await loader.loadAsync(url);
    setObject(gltf.scene, meta);
  }

  function applySmooth(pos, quat, scl) {
    const t = smooth.ready ? 0.32 : 1;
    smooth.pos.lerp(pos, t);
    smooth.quat.slerp(quat, t);
    smooth.scale += (scl - smooth.scale) * t;
    smooth.ready = true;
    head.position.copy(smooth.pos);
    head.quaternion.copy(smooth.quat);
    head.scale.setScalar(smooth.scale);
    if (glasses) {
      glasses.position.set(0, 0, 0);
      glasses.quaternion.identity();
      glasses.scale.setScalar(1);
    }
  }

  function scaleFromDist(dist, opts) {
    const widthCm = glasses?.userData?.frameWidthCm || (opts.frameWidthMm || 127) / 10;
    let modelSpanCm = widthCm;
    if (glasses) {
      const box = new THREE.Box3().setFromObject(glasses);
      modelSpanCm = Math.max(box.getSize(new THREE.Vector3()).x, 1e-4);
    }
    return (
      dist
      * (10 / EYE_SPAN_MM)
      * (widthCm / modelSpanCm)
      * (opts.scale ?? 1.02)
      * (opts.meshScale ?? 1)
    );
  }

  function placeFromEyePixels(left, right, opts) {
    if (!glasses || !camera || !left || !right) return false;
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 10) return false;

    const midX = (left.x + right.x) / 2;
    const midY = (left.y + right.y) / 2 + dist * (opts.offsetY ?? 0.02);
    const nx = dx / dist;
    const ny = dy / dist;
    const zAxis = new THREE.Vector3(-ny, nx, 0.35).normalize();
    const xAxis = new THREE.Vector3(nx, ny, 0);
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    zAxis.crossVectors(xAxis, yAxis).normalize();

    const quat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis),
    );
    const pos = new THREE.Vector3(
      midX - viewW / 2,
      viewH / 2 - midY,
      0,
    ).add(zAxis.clone().multiplyScalar(dist * 0.04));

    applySmooth(pos, quat, scaleFromDist(dist, opts));
    return true;
  }

  function placeFromMatrix(pose, width, height, opts) {
    const data = pose.matrix;
    if (!data || data.length < 16) return false;
    const m = new THREE.Matrix4().fromArray(data);
    m.premultiply(MP_TO_THREE);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    m.decompose(pos, quat, scl);

    const flip = opts.mirror ? -1 : 1;
    const px = flip * pos.x * width * 0.52 + (opts.mirror ? 0 : 0);
    const py = -pos.y * height * 0.52;
    const pz = -pos.z * width * 0.35;

    const left = toVec(pose.left, width, height, opts.mirror);
    const right = toVec(pose.right, width, height, opts.mirror);
    if (!left || !right) return false;
    const dist = left.distanceTo(right);
    if (dist < 10) return false;

    const mid = left.clone().add(right).multiplyScalar(0.5);
    mid.y += dist * (opts.offsetY ?? 0.02);

    const blend = 0.55;
    const finalPos = new THREE.Vector3(
      mid.x * blend + px * (1 - blend),
      mid.y * blend + py * (1 - blend),
      pz,
    );

    const turnY = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      -(pose.yaw || 0) * 0.9,
    );
    const turnX = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      (pose.pitch || 0) * 0.65,
    );
    quat.multiply(turnY).multiply(turnX);

    applySmooth(finalPos, quat, scaleFromDist(dist, opts));
    return true;
  }

  function placeFromPose(pose, width, height, opts = {}) {
    if (!glasses || !camera || !pose || !pose.left || !pose.right) return false;
    if (pose.matrix && placeFromMatrix(pose, width, height, opts)) return true;

    const mirror = !!opts.mirror;
    let left = toVec(pose.left, width, height, mirror);
    let right = toVec(pose.right, width, height, mirror);
    if (!left || !right) return false;
    if (left.x > right.x) {
      const swap = left;
      left = right;
      right = swap;
    }
    const bridge = toVec(pose.bridge || pose.nose, width, height, mirror);
    const nose = toVec(pose.nose, width, height, mirror);
    const xAxis = right.clone().sub(left);
    const dist = xAxis.length();
    if (dist < 10) return false;
    xAxis.normalize();

    const mid = left.clone().add(right).multiplyScalar(0.5);
    if (bridge) {
      mid.x = bridge.x;
      mid.y = (mid.y + bridge.y) * 0.5;
    }
    mid.y += dist * (opts.offsetY ?? 0.02);

    const upHint = new THREE.Vector3(0, 1, 0);
    let zAxis = new THREE.Vector3().crossVectors(xAxis, upHint);
    if (zAxis.lengthSq() < 1e-8) zAxis.set(0, 0, 1);
    zAxis.normalize();
    if (zAxis.z < 0) zAxis.negate();
    if (nose) {
      zAxis.x += ((nose.x - mid.x) / dist) * 0.55;
      zAxis.normalize();
    }
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    zAxis.crossVectors(xAxis, yAxis).normalize();

    const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
    const turnY = new THREE.Quaternion().setFromAxisAngle(yAxis, -(pose.yaw || 0) * 0.95);
    const turnX = new THREE.Quaternion().setFromAxisAngle(xAxis, (pose.pitch || 0) * 0.7);
    quat.multiply(turnY).multiply(turnX);

    const pos = mid.clone().add(zAxis.clone().multiplyScalar(dist * 0.06));
    applySmooth(pos, quat, scaleFromDist(dist, opts));
    return true;
  }

  function place(left, right, scale, offsetY, pose, width, height, item) {
    const opts = {
      scale: typeof scale === "number" ? scale : 1.02,
      offsetY: offsetY ?? 0.02,
      frameWidthMm: item?.frame_width_mm || item?.frameWidthMm || 140,
      meshScale: item?.mesh_scale ?? 1,
      mirror: item?.mirror !== false,
    };
    if (pose && width && height) {
      return placeFromPose(pose, width, height, opts);
    }
    if (left && right && typeof left.x === "number") {
      return placeFromEyePixels(left, right, opts);
    }
    return false;
  }

  function render() {
    if (bgMat.map && bgMat.map.isVideoTexture) bgMat.map.needsUpdate = true;
    if (camera) renderer.render(scene, camera);
  }

  return { resize, setObject, loadUrl, place, render, clearGlasses, setBackground };
}
