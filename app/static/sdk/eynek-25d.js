/**
 * 2.5D VTO — spec: foto-plane (əyilmiş) + linza + qollar.
 * MediaPipe facial matrix (63° FOV, sm), One Euro, üz oklüderi.
 */
import * as THREE from "three";

const FOV = 63;
const FRAME_BEND_CM = 1.15;
const TEMPLE_LEN_CM = 11;
const TEMPLE_H_CM = 0.42;
const TEMPLE_DROP_CM = 0.85;
const LENS_OPACITY = 0.22;
const EYE_SPAN_MM = 92;
const BRIDGE_ANCHOR = new THREE.Vector3(0, -0.35, 1.35);

export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.5, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this._x = null;
    this._dx = 0;
  }

  _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, dt) {
    if (this._x === null) {
      this._x = x;
      this._dx = 0;
      return x;
    }
    if (dt <= 0) return this._x;
    const dx = (x - this._x) / dt;
    const aD = this._alpha(this.dCutoff, dt);
    this._dx += aD * (dx - this._dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this._dx);
    const a = this._alpha(cutoff, dt);
    this._x += a * (x - this._x);
    return this._x;
  }

  reset() {
    this._x = null;
    this._dx = 0;
  }
}

class VectorOneEuroFilter {
  constructor(dim, opts) {
    this.filters = Array.from({ length: dim }, () => new OneEuroFilter(opts));
  }

  filter(values, dt) {
    return this.filters.map((f, i) => f.filter(values[i], dt));
  }

  reset() {
    this.filters.forEach((f) => f.reset());
  }
}

function hexColor(hex) {
  return new THREE.Color(hex || "#333333");
}

export function buildGlasses25(manifest, texture) {
  const group = new THREE.Group();
  const w = (manifest.widthMm || 140) / 10;
  const aspect = manifest.aspect || 2.6;
  const h = w / aspect;
  const half = w / 2;

  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  const frameGeo = new THREE.PlaneGeometry(w, h, 24, 4);
  const fp = frameGeo.attributes.position;
  for (let i = 0; i < fp.count; i += 1) {
    const t = fp.getX(i) / half;
    fp.setZ(i, -FRAME_BEND_CM * t * t);
  }
  frameGeo.computeVertexNormals();
  const frameMat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.renderOrder = 2;
  group.add(frame);

  if (Array.isArray(manifest.lensPolygons)) {
    const tint = hexColor(manifest.lensTint || "#202020");
    for (const poly of manifest.lensPolygons) {
      if (!poly || poly.length < 3) continue;
      const shape = new THREE.Shape(
        poly.map(([px, py]) => new THREE.Vector2((px - 0.5) * w, (0.5 - py) * h)),
      );
      const lens = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({
          color: tint,
          transparent: true,
          opacity: LENS_OPACITY,
          depthWrite: false,
        }),
      );
      lens.position.z = 0.06;
      lens.renderOrder = 3;
      group.add(lens);
    }
  }

  const templeMat = new THREE.MeshStandardMaterial({
    color: hexColor(manifest.frameColor || "#222222"),
    roughness: 0.38,
    metalness: 0.18,
    side: THREE.DoubleSide,
  });
  for (const side of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(side * (half - 0.08), 0.02, -FRAME_BEND_CM * 0.15);
    hinge.rotation.y = side * 1.52;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(TEMPLE_LEN_CM, TEMPLE_H_CM, 0.18), templeMat);
    arm.position.set(TEMPLE_LEN_CM / 2, 0, 0);
    const hook = new THREE.Mesh(new THREE.BoxGeometry(1.4, TEMPLE_H_CM * 0.9, 0.16), templeMat);
    hook.position.set(TEMPLE_LEN_CM - 0.15, -TEMPLE_DROP_CM * 0.45, 0);
    hook.rotation.z = 0.7;
    hinge.add(arm, hook);
    group.add(hinge);
  }

  const shadow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      color: 0x000000,
      opacity: 0.18,
      transparent: true,
      depthWrite: false,
    }),
  );
  shadow.scale.set(w * 0.92, h * 0.55, 1);
  shadow.position.set(0, -h * 0.22, -0.15);
  shadow.renderOrder = 1;
  group.add(shadow);

  const [ax, ay] = manifest.bridgeAnchor || [0.5, 0.4];
  group.userData.bridgeOffset = new THREE.Vector3((ax - 0.5) * w, (0.5 - ay) * h, 0);
  group.userData.widthCm = w;
  return group;
}

export function createScene25(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x111111, 1);

  const scene = new THREE.Scene();
  const persp = new THREE.PerspectiveCamera(FOV, 3 / 4, 1, 10000);
  persp.position.set(0, 0, 0);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
  ortho.position.z = 1200;
  let camera = persp;

  const bgMat = new THREE.MeshBasicMaterial({ depthWrite: false });
  const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bgMat);
  bgMesh.position.z = -200;
  bgMesh.renderOrder = -2;
  bgMesh.visible = false;
  scene.add(bgMesh);

  const head = new THREE.Group();
  scene.add(head);

  const occluder = new THREE.Mesh(
    new THREE.SphereGeometry(8.2, 24, 18),
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  occluder.scale.set(0.55, 0.8, 0.32);
  occluder.position.set(0, -1.0, -6.2);
  occluder.renderOrder = -1;
  head.add(occluder);

  const previewCam = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  previewCam.position.set(8, 5, 22);
  previewCam.lookAt(0, 0, -2);
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  let previewOn = false;
  let glasses = null;
  let viewW = 640;
  let viewH = 800;

  const fx = new OneEuroFilter({ minCutoff: 1.2, beta: 0.4 });
  const fy = new OneEuroFilter({ minCutoff: 1.2, beta: 0.4 });
  const fs = new OneEuroFilter({ minCutoff: 1.4, beta: 0.3 });
  const smoothQ = new THREE.Quaternion();
  let have = false;
  let lastPlaceT = 0;

  function toVec(p, width, height, mirror) {
    if (!p) return null;
    return new THREE.Vector3(
      (mirror ? 1 - p.x : p.x) * width - width / 2,
      (0.5 - p.y) * height,
      -(p.z || 0) * width,
    );
  }

  function resize(width, height) {
    viewW = Math.max(2, width);
    viewH = Math.max(2, height);
    renderer.setSize(viewW, viewH, false);
    ortho.left = -viewW / 2;
    ortho.right = viewW / 2;
    ortho.top = viewH / 2;
    ortho.bottom = -viewH / 2;
    ortho.updateProjectionMatrix();
    persp.aspect = viewW / viewH;
    persp.updateProjectionMatrix();
    previewCam.aspect = viewW / viewH;
    previewCam.updateProjectionMatrix();
    bgMesh.scale.set(viewW, viewH, 1);
  }

  function setBackground(source, mirror) {
    if (bgMat.map) bgMat.map.dispose();
    const tex = source.play ? new THREE.VideoTexture(source) : new THREE.CanvasTexture(source);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
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

  function setGlasses(object) {
    if (glasses) head.remove(glasses);
    glasses = object;
    if (glasses) head.add(glasses);
  }

  function startPreview() {
    previewOn = true;
    camera = previewCam;
    bgMesh.visible = false;
    occluder.visible = false;
    renderer.setClearColor(0x161616, 1);
    head.position.set(0, 0, 0);
    head.quaternion.identity();
    head.rotation.set(0.15, 0.7, 0);
    head.scale.setScalar(1);
    if (glasses) {
      glasses.position.copy(BRIDGE_ANCHOR).sub(glasses.userData.bridgeOffset || new THREE.Vector3());
    }
  }

  function spinPreview() {
    if (previewOn) head.rotation.y += 0.016;
  }

  function stopPreview() {
    previewOn = false;
    camera = ortho;
    bgMesh.visible = true;
    occluder.visible = true;
    head.rotation.set(0, 0, 0);
    renderer.setClearColor(0x111111, 1);
    if (glasses) glasses.position.set(0, 0, 0);
  }

  function place(pose, width, height, opts = {}) {
    if (previewOn) stopPreview();
    if (!glasses || !pose || !pose.left || !pose.right) return false;
    const mirror = !!opts.mirror;
    let left = toVec(pose.left, width, height, mirror);
    let right = toVec(pose.right, width, height, mirror);
    const bridge = toVec(pose.bridge, width, height, mirror);
    const nose = toVec(pose.nose, width, height, mirror);
    if (!left || !right) return false;
    if (left.x > right.x) {
      const swap = left;
      left = right;
      right = swap;
    }
    const xAxis = right.clone().sub(left);
    const dist = xAxis.length();
    if (dist < 12) return false;
    xAxis.normalize();
    const mid = left.clone().add(right).multiplyScalar(0.5);
    if (bridge) {
      mid.x = bridge.x;
      mid.y = (mid.y + bridge.y) * 0.5;
    }
    mid.y += dist * (opts.offsetY ?? 0.02);
    const zAxis = new THREE.Vector3().crossVectors(xAxis, new THREE.Vector3(0, 1, 0));
    if (zAxis.lengthSq() < 1e-8) zAxis.set(0, 0, 1);
    zAxis.normalize();
    if (zAxis.z < 0) zAxis.negate();
    if (nose) zAxis.x += ((nose.x - mid.x) / dist) * 0.45;
    zAxis.normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    zAxis.crossVectors(xAxis, yAxis).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis),
    );
    const widthCm = (glasses.userData && glasses.userData.widthCm) || 14;
    const scl = dist * (10 / EYE_SPAN_MM) * (widthCm / ((opts.widthMm || 140) / 10));
    const now = performance.now() / 1000;
    const dt = lastPlaceT ? Math.min(0.1, now - lastPlaceT) : 0.016;
    lastPlaceT = now;
    const px = fx.filter(mid.x, dt);
    const py = fy.filter(mid.y, dt);
    const s = fs.filter(scl, dt);
    if (have) smoothQ.slerp(q, 0.4);
    else smoothQ.copy(q);
    have = true;
    head.position.set(px, py, 0);
    head.quaternion.copy(smoothQ);
    head.scale.setScalar(s);
    glasses.position.set(0, 0, 0);
    return true;
  }

  function reset() {
    fx.reset();
    fy.reset();
    fs.reset();
    have = false;
    lastPlaceT = 0;
  }

  function render() {
    if (bgMesh.visible && bgMat.map) bgMat.map.needsUpdate = true;
    renderer.render(scene, camera);
  }

  resize(640, 800);
  return {
    resize,
    setBackground,
    setGlasses,
    place,
    render,
    reset,
    startPreview,
    stopPreview,
    spinPreview,
  };
}

export async function loadManifestGlasses(manifest) {
  const loader = new THREE.TextureLoader();
  const tex = await loader.loadAsync(manifest.texture);
  return buildGlasses25(manifest, tex);
}
