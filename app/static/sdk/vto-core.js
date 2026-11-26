/**
 * Eynek VTO runtime: 2.5D glasses (photo front + 3D temples) placed on a tracked face.
 *
 * Scene units: the camera is orthographic in video pixels; the `head` group carries
 * the face pose and is scaled px-per-mm, so everything under it is modelled in mm.
 * Head-local axes: x → wearer's left (screen right), y → up, z → out of the face.
 */
import * as THREE from "three";

const DEFAULT_EYE_SPAN_MM = 88;
const DEFAULT_PD_MM = 63;
const IRIS_MM = 11.7;
const CALIB_SAMPLES = 90;
const PANTO_TILT = THREE.MathUtils.degToRad(7);
const TEMPLE_DROP = THREE.MathUtils.degToRad(4);
const LOST_FACE_MS = 400;
const LM = {
  eyeA: 33,
  eyeB: 263,
  bridge: 168,
  forehead: 10,
  subnasal: 2,
  cheekA: 234,
  cheekB: 454,
  pupilA: 468,
  pupilB: 473,
  irisA: [469, 471],
  irisB: [474, 476],
};

export class OneEuro {
  constructor(minCutoff = 1, beta = 0, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, dt) {
    if (this.x === null || dt <= 0) {
      if (this.x === null) this.x = x;
      return this.x;
    }
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

function loadTexture(url) {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin("anonymous");
  return loader.loadAsync(url).then((tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 16;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    return tex;
  });
}

function bentPlane(w, h, bend, lift = 0) {
  const geo = new THREE.PlaneGeometry(w, h, 48, 4);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const t = pos.getX(i) / (w / 2);
    pos.setZ(i, lift - bend * t * t);
  }
  geo.computeVertexNormals();
  return geo;
}

function shadowTexture(image) {
  const cw = 512;
  const ch = Math.max(64, Math.round((cw * image.height) / image.width));
  const pad = 24;
  const canvas = document.createElement("canvas");
  canvas.width = cw + pad * 2;
  canvas.height = ch + pad * 2;
  const ctx = canvas.getContext("2d");
  ctx.filter = "blur(9px)";
  ctx.drawImage(image, pad, pad, cw, ch);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, scaleX: canvas.width / cw, scaleY: canvas.height / ch };
}

function glareTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 128, 128);
  g.addColorStop(0, "rgba(255,255,255,0.55)");
  g.addColorStop(0.28, "rgba(255,255,255,0.08)");
  g.addColorStop(0.42, "rgba(255,255,255,0)");
  g.addColorStop(0.7, "rgba(255,255,255,0)");
  g.addColorStop(0.86, "rgba(255,255,255,0.16)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function lensGlare(lens, w, h, bend, material) {
  const pts = (lens.polygon || []).map(([px, py]) => new THREE.Vector2((px - 0.5) * w, (0.5 - py) * h));
  if (pts.length < 3) return null;
  const geo = new THREE.ShapeGeometry(new THREE.Shape(pts));
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const [bx, by, bw, bh] = lens.box;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const t = x / (w / 2);
    pos.setZ(i, 0.4 - bend * t * t);
    uv.setXY(i, (x / w + 0.5 - bx) / bw, 1 - (0.5 - y / h - by) / bh);
  }
  return new THREE.Mesh(geo, material);
}

function templeGeometry(length, h0, h1, thick) {
  const straight = length * 0.68;
  const hook = Math.min(14, length - straight);
  const drop = straight * 0.05;
  const line = [];
  const n = 18;
  for (let i = 0; i <= n; i += 1) {
    const u = (i / n) * straight;
    line.push(new THREE.Vector2(u, -drop * (u / straight) ** 1.6));
  }
  const m = 6;
  for (let j = 1; j <= m; j += 1) {
    const a = 0.12 + (j / m) * 0.75;
    const prev = line[line.length - 1];
    line.push(new THREE.Vector2(prev.x + Math.cos(a) * (hook / m), prev.y - Math.sin(a) * (hook / m)));
  }
  const top = [];
  const bottom = [];
  for (let k = 0; k < line.length; k += 1) {
    const a = line[Math.max(0, k - 1)];
    const b = line[Math.min(line.length - 1, k + 1)];
    const dir = b.clone().sub(a).normalize();
    const normal = new THREE.Vector2(-dir.y, dir.x);
    const t = Math.min(1, (k / (line.length - 1)) * 1.5);
    const half = (h0 + (h1 - h0) * t) / 2;
    top.push(line[k].clone().addScaledVector(normal, half));
    bottom.push(line[k].clone().addScaledVector(normal, -half));
  }
  const shape = new THREE.Shape([...top, ...bottom.reverse()]);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thick,
    bevelEnabled: true,
    bevelThickness: thick * 0.3,
    bevelSize: Math.min(0.6, h1 * 0.2),
    bevelSegments: 2,
    curveSegments: 4,
  });
  geo.translate(0, 0, -thick / 2);
  geo.rotateY(Math.PI / 2);
  return geo;
}

/** Temple traced from the seller's side photo: x runs back from the hinge, y up, in mm. */
function profileGeometry(points, thick) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const bevel = Math.min(0.45, thick * 0.22);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thick,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 2,
    curveSegments: 1,
  });
  geo.translate(0, 0, -thick / 2);
  geo.rotateY(Math.PI / 2);
  return geo;
}

/** Cap UVs of an extruded shape are its mm coordinates; map the profile's box onto [0,1]. */
function profileTexture(tex, uv, flip) {
  const t = flip ? tex.clone() : tex;
  const [x0, y0, w, h] = uv;
  t.repeat.set((flip ? -1 : 1) / w, 1 / h);
  t.offset.set(flip ? 1 + x0 / w : -x0 / w, -y0 / h);
  t.needsUpdate = true;
  return t;
}

function blobTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export async function buildGlasses(manifest) {
  const templeSides = manifest.templeSides || {};
  const templeUrls = manifest.templeTextures || {};
  const [tex, ...sideTex] = await Promise.all([
    loadTexture(manifest.texture),
    ...["left", "right"].map((side) =>
      templeSides[side] && templeSides[side].profile && templeUrls[side]
        ? loadTexture(templeUrls[side]).catch(() => null)
        : Promise.resolve(null),
    ),
  ]);
  const photoTemples = { left: sideTex[0], right: sideTex[1] };
  const W = manifest.widthMm || 138;
  const H = manifest.heightMm || W / (manifest.aspect || 2.8);
  const bend = W * 0.055;
  const root = new THREE.Group();
  const face = new THREE.Group();
  face.rotation.x = PANTO_TILT;
  root.add(face);

  const front = new THREE.Mesh(
    bentPlane(W, H, bend),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      alphaTest: 0.06,
      side: THREE.DoubleSide,
    }),
  );
  front.renderOrder = 4;
  face.add(front);

  const [ax, ay] = manifest.bridgeAnchor || [0.5, 0.45];
  const bridge = new THREE.Vector3((ax - 0.5) * W, (0.5 - ay) * H, 0);

  // Shadows sit on the skin, so they skip the depth test against the head occluder.
  const shadow = shadowTexture(tex.image);
  const shadowMesh = new THREE.Mesh(
    bentPlane(W * shadow.scaleX, H * shadow.scaleY, bend, -4),
    new THREE.MeshBasicMaterial({ map: shadow.tex, transparent: true, opacity: 0.22, depthWrite: false, depthTest: false }),
  );
  shadowMesh.position.y = -2.2;
  shadowMesh.renderOrder = 1;
  face.add(shadowMesh);

  const blob = blobTexture();
  const noseMat = new THREE.MeshBasicMaterial({ map: blob, transparent: true, opacity: 0.3, depthWrite: false, depthTest: false });
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(9, 15), noseMat);
    pad.position.set(bridge.x + side * 7.5, bridge.y - 9, -5);
    pad.rotation.z = side * 0.35;
    pad.renderOrder = 1;
    face.add(pad);
  }

  const glareMat = new THREE.MeshBasicMaterial({
    map: glareTexture(),
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (const lens of manifest.lenses || []) {
    const dark = lens.sunglass || (!lens.clear && (lens.opacity || 0) >= 0.8);
    if (dark) continue;
    const mesh = lensGlare(lens, W, H, bend, glareMat);
    if (mesh) {
      mesh.renderOrder = 4;
      face.add(mesh);
    }
  }

  const templeBase = manifest.temple || {};
  const hinge = manifest.hinge || { y: 0.32, heightMm: 5 };
  const pivots = [];

  function sideConfig(sideKey) {
    const other = sideKey === "left" ? "right" : "left";
    const own = templeSides[sideKey] || {};
    const cfg = own.profile && photoTemples[sideKey] ? own : { ...(templeSides[other] || {}), ...own };
    const source = own.profile && photoTemples[sideKey] ? sideKey : templeSides[other]?.profile && photoTemples[other] ? other : null;
    const finish = cfg.finish || templeBase.finish || "acetate";
    const metal = finish === "metal";
    const rimMm = cfg.rimMm ?? templeBase.rimMm ?? 4;
    const h0 = THREE.MathUtils.clamp(rimMm, 1.4, 9);
    const h1 = Math.max(1.2, h0 * (metal ? 0.5 : 0.58));
    const thick = THREE.MathUtils.clamp(cfg.thickMm ?? templeBase.thickMm ?? h0 * (metal ? 0.5 : 0.42), 0.8, 4.5);
    const length = templeBase.lengthMm || cfg.lengthMm || 145;
    const color = cfg.color || templeBase.color || manifest.frameColor || "#222222";
    const profile = source ? templeSides[source].profile : null;
    return { metal, h0, h1, thick, length, color, profile, source };
  }

  // Head-local +x is the wearer's left, so side +1 carries the "left" temple.
  for (const side of [-1, 1]) {
    const sideKey = side > 0 ? "left" : "right";
    const cfg = sideConfig(sideKey);
    const map = cfg.profile ? profileTexture(photoTemples[cfg.source], cfg.profile.uv, cfg.source !== sideKey) : null;
    const armMat = new THREE.MeshStandardMaterial({
      color: map ? new THREE.Color(0.72, 0.72, 0.72) : new THREE.Color(cfg.color),
      map,
      roughness: cfg.metal ? 0.32 : 0.5,
      metalness: cfg.metal ? 0.55 : 0.04,
    });
    const geo = cfg.profile ? profileGeometry(cfg.profile.points, cfg.thick) : templeGeometry(cfg.length, cfg.h0, cfg.h1, cfg.thick);
    const pivot = new THREE.Group();
    const hingeX = W / 2 - Math.max(3.5, cfg.thick * 1.4);
    const t = hingeX / (W / 2);
    pivot.position.set(side * hingeX, (0.5 - hinge.y) * H, -bend * t * t - cfg.thick * 0.6);
    // Only the front carries the pantoscopic tilt; temples run back and slightly down to the ears.
    pivot.rotation.x = -PANTO_TILT - TEMPLE_DROP;
    const arm = new THREE.Mesh(geo, armMat);
    arm.renderOrder = 3;
    pivot.add(arm);
    pivot.userData.side = side;
    pivot.userData.hingeX = hingeX;
    face.add(pivot);
    pivots.push(pivot);
  }

  const armLength = templeBase.lengthMm || sideConfig("left").length || 145;
  root.userData = {
    widthMm: W,
    heightMm: H,
    straightMm: armLength * 0.68,
    bridge,
    face,
    pivots,
  };
  return root;
}

function superEllipsoid(a, b, c, e = 3) {
  const geo = new THREE.SphereGeometry(1, 36, 24);
  const pos = geo.attributes.position;
  const k = 2 / e;
  const f = (v) => Math.sign(v) * Math.abs(v) ** k;
  for (let i = 0; i < pos.count; i += 1) {
    pos.setXYZ(i, f(pos.getX(i)) * a, f(pos.getY(i)) * b, f(pos.getZ(i)) * c);
  }
  return geo;
}

function readMatrix(arr) {
  const m = new THREE.Matrix4().fromArray(arr);
  const rowMajor = Math.abs(arr[3]) + Math.abs(arr[7]) + Math.abs(arr[11]) > Math.abs(arr[12]) + Math.abs(arr[13]) + Math.abs(arr[14]);
  return rowMajor ? m.transpose() : m;
}

export function createTryOn(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8178, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(0.35, 0.7, 1);
  scene.add(key);

  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 8000);
  ortho.position.z = 4000;
  const persp = new THREE.PerspectiveCamera(28, 1, 10, 4000);
  persp.position.set(0, 34, 330);
  persp.lookAt(0, 0, 0);

  const bgMat = new THREE.MeshBasicMaterial({ depthWrite: false, depthTest: false });
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bgMat);
  bg.position.z = -3000;
  bg.renderOrder = -10;
  scene.add(bg);

  // Depth-only head: hides whatever part of the frame is behind the face (far temple,
  // temple tips behind the ears). Head-local mm, origin at the nose bridge.
  const head = new THREE.Group();
  head.visible = false;
  scene.add(head);
  const hiddenMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const occluder = new THREE.Mesh(superEllipsoid(1, 1, 1, 4), hiddenMat);
  occluder.renderOrder = -2;
  occluder.position.set(0, -10, -85);
  head.add(occluder);
  const ears = [-1, 1].map((side) => {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), hiddenMat);
    ear.scale.set(7, 27, 15);
    ear.userData.side = side;
    ear.renderOrder = -2;
    head.add(ear);
    return ear;
  });

  let glasses = null;
  let mirror = true;
  let viewW = 640;
  let viewH = 480;
  let mode = "live";
  let fit = { offsetY: 0, offsetZ: 0, scale: 1 };
  let lastSeen = 0;
  let lastT = 0;
  let have = false;
  const smoothQ = new THREE.Quaternion();
  const filters = {
    x: new OneEuro(1.2, 0.012),
    y: new OneEuro(1.2, 0.012),
    z: new OneEuro(1.0, 0.01),
    s: new OneEuro(0.9, 0.6),
    zf: new OneEuro(0.4, 0),
    ear: new OneEuro(0.3, 0),
  };
  const calib = { eye: [], pd: [], face: [], manualPd: null };

  const tmp = {
    a: new THREE.Vector3(),
    b: new THREE.Vector3(),
    c: new THREE.Vector3(),
    x: new THREE.Vector3(),
    y: new THREE.Vector3(),
    z: new THREE.Vector3(),
    o: new THREE.Vector3(),
    mx: new THREE.Vector3(),
    my: new THREE.Vector3(),
    pos: new THREE.Vector3(),
    scl: new THREE.Vector3(),
    m: new THREE.Matrix4(),
    q: new THREE.Quaternion(),
  };

  function resize(width, height) {
    viewW = Math.max(2, Math.round(width));
    viewH = Math.max(2, Math.round(height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(viewW, viewH, false);
    Object.assign(ortho, { left: -viewW / 2, right: viewW / 2, top: viewH / 2, bottom: -viewH / 2 });
    ortho.updateProjectionMatrix();
    persp.aspect = viewW / viewH;
    persp.updateProjectionMatrix();
    bg.scale.set(viewW, viewH, 1);
  }

  function setSource(source, opts = {}) {
    mirror = opts.mirror ?? !!source.play;
    if (bgMat.map) bgMat.map.dispose();
    const tex = source.play ? new THREE.VideoTexture(source) : new THREE.CanvasTexture(source);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.x = mirror ? -1 : 1;
    tex.offset.x = mirror ? 1 : 0;
    bgMat.map = tex;
    bgMat.needsUpdate = true;
    if (glasses) glasses.userData.face.scale.x = mirror ? -1 : 1;
    resetTracking();
    resetCalibration();
  }

  async function setProduct(manifest) {
    const next = await buildGlasses(manifest);
    if (glasses) head.remove(glasses);
    glasses = next;
    glasses.userData.face.scale.x = mirror && mode === "live" ? -1 : 1;
    head.add(glasses);
    fit = { offsetY: 0, offsetZ: 0, scale: 1, ...(manifest.fit || {}) };
    if (mode === "preview") posePreview(0);
    else if (have) layout(lastLayout.zFront, lastLayout.faceHalf);
    return glasses;
  }

  function setFit(next) {
    fit = { ...fit, ...next };
  }

  function resetTracking() {
    Object.values(filters).forEach((f) => f.reset());
    have = false;
    lastT = 0;
    head.visible = mode === "preview";
  }

  function resetCalibration() {
    calib.eye.length = 0;
    calib.pd.length = 0;
    calib.face.length = 0;
  }

  function point(lm, i, out) {
    const p = lm[i];
    return out.set((mirror ? 1 - p.x : p.x) * viewW - viewW / 2, (0.5 - p.y) * viewH, -(p.z || 0) * viewW);
  }

  function flat(lm, i, j) {
    return Math.hypot((lm[i].x - lm[j].x) * viewW, (lm[i].y - lm[j].y) * viewH);
  }

  function median(list) {
    if (!list.length) return null;
    const s = [...list].sort((p, q) => p - q);
    return s[s.length >> 1];
  }

  function remember(list, value) {
    list.push(value);
    if (list.length > CALIB_SAMPLES) list.shift();
  }

  /** Iris diameter is nearly the same for every adult, so it turns pixels into mm. */
  function calibrate(lm) {
    if (lm.length < 478) return;
    const iris = (flat(lm, ...LM.irisA) + flat(lm, ...LM.irisB)) / 2;
    if (iris < 4) return;
    const mm = IRIS_MM / iris;
    const eye = flat(lm, LM.eyeA, LM.eyeB) * mm;
    const pd = flat(lm, LM.pupilA, LM.pupilB) * mm;
    if (eye < 72 || eye > 108 || pd < 48 || pd > 80) return;
    remember(calib.eye, eye);
    remember(calib.pd, pd);
    remember(calib.face, flat(lm, LM.cheekA, LM.cheekB) * mm);
  }

  function eyeSpanMm() {
    const eye = calib.eye.length >= 3 ? median(calib.eye) : DEFAULT_EYE_SPAN_MM;
    if (calib.manualPd == null) return eye;
    const pd = calib.pd.length >= 3 ? median(calib.pd) : DEFAULT_PD_MM;
    return eye * (calib.manualPd / pd);
  }

  function measurements() {
    const pdAuto = median(calib.pd);
    const ratio = calib.manualPd != null && pdAuto ? calib.manualPd / pdAuto : 1;
    const faceAuto = median(calib.face);
    const faceWidthMm = faceAuto ? faceAuto * ratio : null;
    const frameWidthMm = glasses ? glasses.userData.widthMm * (fit.scale || 1) : null;
    let fitLabel = null;
    if (faceWidthMm && frameWidthMm) {
      const diff = frameWidthMm - faceWidthMm;
      fitLabel = diff > 10 ? "wide" : diff < -4 ? "narrow" : "good";
    }
    return {
      calibrated: calib.pd.length >= 8,
      auto: calib.manualPd == null,
      pdMm: calib.manualPd ?? pdAuto,
      pdAutoMm: pdAuto,
      faceWidthMm,
      frameWidthMm,
      fit: fitLabel,
    };
  }

  function setManualPd(mm) {
    calib.manualPd = mm == null ? null : THREE.MathUtils.clamp(Number(mm), 48, 80);
  }

  function update(face, now = performance.now()) {
    if (mode !== "live" || !glasses) return false;
    if (!face) {
      if (now - lastSeen > LOST_FACE_MS) {
        head.visible = false;
        have = false;
      }
      return false;
    }
    const lm = face.landmarks;
    const { a, b, c, x, y, z, o } = tmp;
    point(lm, LM.eyeA, a);
    point(lm, LM.eyeB, b);
    if (a.x > b.x) {
      c.copy(a);
      a.copy(b);
      b.copy(c);
    }
    const span = a.distanceTo(b);
    if (span < 12) return false;
    x.subVectors(b, a).normalize();
    const eyeMid = c.addVectors(a, b).multiplyScalar(0.5);
    point(lm, LM.bridge, o);
    point(lm, LM.forehead, y).sub(point(lm, LM.subnasal, tmp.a));
    y.addScaledVector(x, -y.dot(x)).normalize();
    z.crossVectors(x, y).normalize();
    tmp.q.setFromRotationMatrix(tmp.m.makeBasis(x, y, z));

    if (face.matrix) {
      // MediaPipe's pose is steadier, but it lives in the un-mirrored camera frame:
      // mirroring the image is a reflection across x, i.e. (qx, -qy, -qz, qw).
      const fq = new THREE.Quaternion();
      readMatrix(face.matrix).decompose(tmp.pos, fq, tmp.scl);
      if (mirror) fq.set(fq.x, -fq.y, -fq.z, fq.w);
      const okX = tmp.mx.set(1, 0, 0).applyQuaternion(fq).dot(x) > 0.75;
      const okY = tmp.my.set(0, 1, 0).applyQuaternion(fq).dot(y) > 0.6;
      if (okX && okY) tmp.q.copy(fq);
    }

    if (Math.abs(z.x) < 0.22 && Math.abs(z.y) < 0.28) calibrate(lm);
    const pxPerMm = span / eyeSpanMm();
    const bridgeZ = tmp.b.copy(o).sub(eyeMid).dot(z) / pxPerMm;
    const faceHalf = point(lm, LM.cheekA, tmp.a).distanceTo(point(lm, LM.cheekB, tmp.b)) / 2 / pxPerMm;

    const dt = lastT ? Math.min(0.1, Math.max(0.001, (now - lastT) / 1000)) : 1 / 30;
    lastT = now;
    lastSeen = now;
    if (!have) smoothQ.copy(tmp.q);
    else smoothQ.slerp(tmp.q, THREE.MathUtils.clamp(0.35 + smoothQ.angleTo(tmp.q) * 4, 0.35, 1));
    have = true;

    head.visible = true;
    head.position.set(filters.x.filter(o.x, dt), filters.y.filter(o.y, dt), filters.z.filter(o.z, dt));
    head.quaternion.copy(smoothQ);
    head.scale.setScalar(filters.s.filter(pxPerMm, dt));

    const zFront = THREE.MathUtils.clamp(filters.zf.filter(bridgeZ, dt) * 0.5 + 2, 7, 13);
    layout(zFront, THREE.MathUtils.clamp(filters.ear.filter(faceHalf, dt), 58, 82));
    return true;
  }

  const lastLayout = { zFront: 10, faceHalf: 68 };

  /** Temples run just outside the head's side wall; the occluder is the head itself. */
  function layout(zFront, faceHalf) {
    lastLayout.zFront = zFront;
    lastLayout.faceHalf = faceHalf;
    const u = glasses.userData;
    const s = fit.scale || 1;
    const bx = mirror && mode === "live" ? -u.bridge.x : u.bridge.x;
    glasses.scale.setScalar(s);
    glasses.position.set(-bx * s, -u.bridge.y * s + (fit.offsetY || 0), zFront + (fit.offsetZ || 0));
    const sideHalf = faceHalf + 4;
    const reach = Math.max(48, u.straightMm * s);
    for (const pivot of u.pivots) {
      const splay = Math.atan2(sideHalf + 1.5 - pivot.userData.hingeX * s, reach);
      pivot.rotation.y = -pivot.userData.side * THREE.MathUtils.clamp(splay, -0.12, 0.3);
    }
    const a = sideHalf - 3;
    occluder.scale.set(a, 118, 90);
    for (const ear of ears) ear.position.set(ear.userData.side * (sideHalf + 5), -38, -90);
  }

  function posePreview(angle) {
    head.visible = true;
    head.position.set(0, 0, 0);
    head.scale.setScalar(1);
    head.quaternion.setFromEuler(new THREE.Euler(0.12, angle, 0));
    if (glasses) layout(50, 66);
  }

  function startPreview(clear = 0xf4f2ee) {
    mode = "preview";
    bg.visible = false;
    occluder.visible = false;
    ears.forEach((ear) => (ear.visible = false));
    renderer.setClearColor(clear, 1);
    if (glasses) glasses.userData.face.scale.x = 1;
    posePreview(0);
  }

  function startLive() {
    mode = "live";
    bg.visible = true;
    occluder.visible = true;
    ears.forEach((ear) => (ear.visible = true));
    if (glasses) glasses.userData.face.scale.x = mirror ? -1 : 1;
    resetTracking();
  }

  function render(t = performance.now()) {
    if (mode === "preview") posePreview(Math.sin(t / 1600) * 0.95);
    renderer.render(scene, mode === "preview" ? persp : ortho);
  }

  function snapshot(type = "image/jpeg", quality = 0.92) {
    render();
    return canvas.toDataURL(type, quality);
  }

  resize(640, 480);
  return {
    resize,
    setSource,
    setProduct,
    setFit,
    update,
    render,
    snapshot,
    startPreview,
    startLive,
    measurements,
    setManualPd,
    renderer,
  };
}
