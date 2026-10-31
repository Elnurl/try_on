/**
 * Eynek VTO runtime: 2.5D glasses (photo front + 3D temples) placed on a tracked face.
 *
 * Scene units: the camera is orthographic in video pixels; the `head` group carries
 * the face pose and is scaled px-per-mm, so everything under it is modelled in mm.
 * Head-local axes: x → wearer's left (screen right), y → up, z → out of the face.
 */
import * as THREE from "three";

const EYE_SPAN_MM = 88;
const PANTO_TILT = THREE.MathUtils.degToRad(7);
const FRAME_GAP_MM = 3;
const LOST_FACE_MS = 350;
const LM = { eyeA: 33, eyeB: 263, bridge: 168, forehead: 10, chin: 152, subnasal: 2, cheekA: 234, cheekB: 454 };

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
    tex.anisotropy = 8;
    return tex;
  });
}

function bentPlane(w, h, bend, lift = 0) {
  const geo = new THREE.PlaneGeometry(w, h, 40, 2);
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

export async function buildGlasses(manifest) {
  const tex = await loadTexture(manifest.texture);
  const W = manifest.widthMm || 138;
  const H = manifest.heightMm || W / (manifest.aspect || 2.8);
  const bend = W * 0.055;
  const root = new THREE.Group();
  const face = new THREE.Group();
  face.rotation.x = PANTO_TILT;
  root.add(face);

  const front = new THREE.Mesh(
    bentPlane(W, H, bend),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  front.renderOrder = 3;
  face.add(front);

  const shadow = shadowTexture(tex.image);
  const shadowMesh = new THREE.Mesh(
    bentPlane(W * shadow.scaleX, H * shadow.scaleY, bend, -4),
    new THREE.MeshBasicMaterial({ map: shadow.tex, transparent: true, opacity: 0.2, depthWrite: false }),
  );
  shadowMesh.position.y = -2.2;
  shadowMesh.renderOrder = 1;
  face.add(shadowMesh);

  const glareMat = new THREE.MeshBasicMaterial({
    map: glareTexture(),
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (const lens of manifest.lenses || []) {
    const mesh = lensGlare(lens, W, H, bend, glareMat);
    if (mesh) {
      mesh.renderOrder = 4;
      face.add(mesh);
    }
  }

  const temple = manifest.temple || {};
  const metal = temple.finish === "metal";
  const templeMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(temple.color || manifest.frameColor || "#222222"),
    roughness: metal ? 0.32 : 0.42,
    metalness: metal ? 0.55 : 0.08,
  });
  const hinge = manifest.hinge || { y: 0.32, heightMm: 5 };
  const h0 = THREE.MathUtils.clamp(hinge.heightMm, 2.5, 9);
  const thick = metal ? 1.4 : 2.4;
  const length = temple.lengthMm || 145;
  const geo = templeGeometry(length, h0, Math.max(2, h0 * 0.62), thick);
  const pivots = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * (W / 2 - thick * 0.6), (0.5 - hinge.y) * H, -bend + 0.4);
    const arm = new THREE.Mesh(geo, templeMat);
    arm.renderOrder = 2;
    pivot.add(arm);
    pivot.userData.side = side;
    root.add(pivot);
    pivots.push(pivot);
  }

  const [ax, ay] = manifest.bridgeAnchor || [0.5, 0.45];
  root.userData = {
    widthMm: W,
    heightMm: H,
    straightMm: length * 0.68,
    bridge: new THREE.Vector3((ax - 0.5) * W, (0.5 - ay) * H, 0),
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
  renderer.setPixelRatio(1);

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

  const head = new THREE.Group();
  head.visible = false;
  scene.add(head);
  const occluder = new THREE.Mesh(superEllipsoid(1, 1, 1), new THREE.MeshBasicMaterial({ colorWrite: false }));
  occluder.renderOrder = -1;
  occluder.position.set(0, -18, -88);
  head.add(occluder);

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

  const tmp = {
    a: new THREE.Vector3(),
    b: new THREE.Vector3(),
    x: new THREE.Vector3(),
    y: new THREE.Vector3(),
    z: new THREE.Vector3(),
    up: new THREE.Vector3(),
    o: new THREE.Vector3(),
    m: new THREE.Matrix4(),
    q: new THREE.Quaternion(),
  };

  function resize(width, height) {
    viewW = Math.max(2, Math.round(width));
    viewH = Math.max(2, Math.round(height));
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
  }

  async function setProduct(manifest) {
    const next = await buildGlasses(manifest);
    if (glasses) head.remove(glasses);
    glasses = next;
    glasses.userData.face.scale.x = mirror && mode === "live" ? -1 : 1;
    head.add(glasses);
    fit = { offsetY: 0, offsetZ: 0, scale: 1, ...(manifest.fit || {}) };
    if (mode === "preview") posePreview(0);
    return glasses;
  }

  function setFit(next) {
    fit = { ...fit, ...next };
  }

  function resetTracking() {
    Object.values(filters).forEach((f) => f.reset());
    have = false;
    lastT = 0;
  }

  function point(lm, i, out) {
    const p = lm[i];
    return out.set((mirror ? 1 - p.x : p.x) * viewW - viewW / 2, (0.5 - p.y) * viewH, -(p.z || 0) * viewW);
  }

  function update(face, now = performance.now()) {
    if (mode !== "live" || !glasses) return false;
    if (!face) {
      if (now - lastSeen > LOST_FACE_MS) {
        head.visible = false;
        resetTracking();
      }
      return false;
    }
    const lm = face.landmarks;
    const { a, b, x, y, z, up, o } = tmp;
    point(lm, LM.eyeA, a);
    point(lm, LM.eyeB, b);
    if (a.x > b.x) {
      const t = a.clone();
      a.copy(b);
      b.copy(t);
    }
    const span = a.distanceTo(b);
    if (span < 18) return false;
    const pxPerMm = span / EYE_SPAN_MM;
    x.subVectors(b, a).normalize();
    o.addVectors(a, b).multiplyScalar(0.5);

    point(lm, LM.forehead, up).sub(point(lm, LM.chin, y));
    if (face.matrix) {
      readMatrix(face.matrix).extractBasis(tmp.z, y, tmp.z);
      if (mirror) y.x = -y.x;
      if (y.dot(up) < 0) y.negate();
    } else {
      point(lm, LM.forehead, y).sub(point(lm, LM.subnasal, tmp.z));
    }
    y.addScaledVector(x, -y.dot(x)).normalize();
    z.crossVectors(x, y).normalize();
    tmp.q.setFromRotationMatrix(tmp.m.makeBasis(x, y, z));

    const bridgeZ = point(lm, LM.bridge, tmp.a).sub(o).dot(z) / pxPerMm;
    const earHalf = point(lm, LM.cheekA, tmp.a).distanceTo(point(lm, LM.cheekB, tmp.b)) / 2 / pxPerMm;

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

    const zFront = THREE.MathUtils.clamp(filters.zf.filter(bridgeZ, dt), 8, 26) + FRAME_GAP_MM;
    const ear = THREE.MathUtils.clamp(filters.ear.filter(earHalf, dt), 55, 85);
    layout(zFront, ear);
    return true;
  }

  function layout(zFront, earHalf) {
    const u = glasses.userData;
    const s = fit.scale || 1;
    const bx = mirror && mode === "live" ? -u.bridge.x : u.bridge.x;
    glasses.scale.setScalar(s);
    glasses.position.set(-bx * s, -u.bridge.y * s + (fit.offsetY || 0), zFront + (fit.offsetZ || 0));
    const frameHalf = (u.widthMm / 2) * s;
    const splay = Math.atan2(THREE.MathUtils.clamp(earHalf + 2 - frameHalf, -4, 12), u.straightMm * s);
    for (const pivot of u.pivots) pivot.rotation.y = -pivot.userData.side * splay;
    const a = THREE.MathUtils.clamp(Math.min(earHalf - 3, frameHalf - 4), 45, 80);
    occluder.scale.set(a, 108, 94);
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
    renderer.setClearColor(clear, 1);
    if (glasses) glasses.userData.face.scale.x = 1;
    posePreview(0);
  }

  function startLive() {
    mode = "live";
    bg.visible = true;
    occluder.visible = true;
    head.visible = false;
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
  return { resize, setSource, setProduct, setFit, update, render, snapshot, startPreview, startLive, renderer };
}
