/**
 * Eynek VTO runtime: 2.5D glasses (photo front + 3D temples) placed on a tracked face.
 *
 * Scene units: the camera is orthographic in video pixels; the `head` group carries
 * the face pose and is scaled px-per-mm, so everything under it is modelled in mm.
 * Head-local axes: x → wearer's left (screen right), y → up, z → out of the face.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const DRACO_PATH = "/static/vendor/three/examples/jsm/libs/draco/gltf/";
let _gltfLoader = null;
function getGltfLoader() {
  if (!_gltfLoader) {
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_PATH);
    _gltfLoader = new GLTFLoader();
    _gltfLoader.setDRACOLoader(draco);
  }
  return _gltfLoader;
}

const DEFAULT_EYE_SPAN_MM = 88;
const DEFAULT_PD_MM = 63;
const IRIS_MM = 11.7;
const CALIB_SAMPLES = 90;
const PANTO_TILT = THREE.MathUtils.degToRad(7);
const TEMPLE_DROP = THREE.MathUtils.degToRad(1.5);
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
// MediaPipe 468-landmark outer face oval (clockwise from top of forehead).
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const SIDE_OVAL = new Set([284, 251, 389, 356, 454, 323, 361, 288, 21, 54, 127, 162, 234, 93, 132, 58]);

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

/** Opaque rim-only texture (lenses stripped) for volumetric 3D front thickness layers. */
function rimTexture(image) {
  const cw = 512;
  const ch = Math.max(64, Math.round((cw * image.height) / image.width));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, cw, ch);
  const img = ctx.getImageData(0, 0, cw, ch);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 210) {
      d[i + 3] = 0;
    } else {
      d[i] = Math.round(d[i] * 0.55);
      d[i + 1] = Math.round(d[i + 1] * 0.55);
      d[i + 2] = Math.round(d[i + 2] * 0.55);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** Realistic studio window reflection map; UV offset glides dynamically with head rotation. */
function glareTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  // Main diagonal studio softbox reflection with generous transparent margins for sliding.
  const g1 = ctx.createLinearGradient(32, 16, 224, 240);
  g1.addColorStop(0.0, "rgba(255,255,255,0)");
  g1.addColorStop(0.22, "rgba(255,255,255,0)");
  g1.addColorStop(0.32, "rgba(255,255,255,0.52)");
  g1.addColorStop(0.41, "rgba(255,255,255,0.14)");
  g1.addColorStop(0.49, "rgba(255,255,255,0)");
  g1.addColorStop(0.64, "rgba(255,255,255,0)");
  g1.addColorStop(0.71, "rgba(255,255,255,0.22)");
  g1.addColorStop(0.78, "rgba(255,255,255,0)");
  g1.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, 256, 256);
  // Subtle upper curved sky sheen.
  const g2 = ctx.createRadialGradient(110, 64, 8, 110, 64, 110);
  g2.addColorStop(0, "rgba(240,248,255,0.26)");
  g2.addColorStop(0.6, "rgba(240,248,255,0.06)");
  g2.addColorStop(1, "rgba(240,248,255,0)");
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
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

/** Smooth ergonomic 3D temple sized from the seller's side photo (mm). */
function templeGeometry(length, h0, h1, thick, side, metal) {
  const straight = length * 0.74;
  const hook = Math.min(16, Math.max(12, length - straight));
  const drop = straight * 0.015;
  const line = [];
  const n = 20;
  for (let i = 0; i <= n; i += 1) {
    const f = i / n;
    const u = -2.2 + f * (straight + 2.2);
    line.push(new THREE.Vector2(u, -drop * f * f));
  }
  const m = 10;
  for (let j = 1; j <= m; j += 1) {
    const f = j / m;
    const a = 0.05 + f * f * 0.78;
    const prev = line[line.length - 1];
    line.push(new THREE.Vector2(prev.x + Math.cos(a) * (hook / m), prev.y - Math.sin(a) * (hook / m)));
  }
  const top = [];
  const bottom = [];
  const total = line.length - 1;
  for (let k = 0; k <= total; k += 1) {
    const a = line[Math.max(0, k - 1)];
    const b = line[Math.min(total, k + 1)];
    const dir = b.clone().sub(a).normalize();
    const normal = new THREE.Vector2(-dir.y, dir.x);
    let h;
    if (k <= n) {
      const f = k / n;
      h = h0 + (h1 - h0) * Math.min(1, f * 1.15);
    } else {
      // Gentle ergonomic tip swell behind the ear, then rounded end.
      const f = (k - n) / m;
      const swell = metal ? 1 + 0.18 * Math.sin(f * Math.PI) : 1 + 0.28 * Math.sin(f * Math.PI);
      const endTaper = f > 0.78 ? 1 - ((f - 0.78) / 0.22) * 0.35 : 1;
      h = h1 * swell * endTaper;
    }
    top.push(line[k].clone().addScaledVector(normal, h / 2));
    bottom.push(line[k].clone().addScaledVector(normal, -h / 2));
  }
  const shape = new THREE.Shape([...top, ...bottom.reverse()]);
  const bevel = Math.min(0.45, thick * 0.28, h1 * 0.22);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thick,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel * 0.4,
    bevelSegments: 3,
    curveSegments: 4,
  });
  geo.translate(0, 0, -thick / 2);
  geo.rotateY(Math.PI / 2);
  // Subtle inward curve behind the ear so the tip hugs the head naturally.
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    if (z < -straight) {
      const f = THREE.MathUtils.clamp((-z - straight) / hook, 0, 1);
      pos.setX(i, pos.getX(i) - side * 4.5 * f * f);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

/** Map a straight-section pattern/logo strip cleanly onto the smooth 3D temple. */
function templeTexture(tex, straightMm, heightMm) {
  const t = tex.clone();
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  const span = Math.max(20, straightMm * 0.82);
  const h = Math.max(2, heightMm);
  t.repeat.set(1 / span, 1 / h);
  t.offset.set(-0.08, 0.5);
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

/** Load and normalise a real 3D .glb eyewear model into head-local millimetres. */
async function buildGlbGlasses(manifest) {
  const [gltf, frontTex] = await Promise.all([
    getGltfLoader().loadAsync(manifest.model),
    manifest.autoGlb && manifest.texture ? loadTexture(manifest.texture).catch(() => null) : Promise.resolve(null),
  ]);
  const model = gltf.scene;
  const W = manifest.widthMm || 138;
  const tLeft = model.getObjectByName("temple_left");
  const tRight = model.getObjectByName("temple_right");
  const isAuto = Boolean(manifest.autoGlb && tLeft && tRight);

  const root = new THREE.Group();
  const face = new THREE.Group();
  const pivots = [];
  let modelHeightMm = manifest.heightMm || W / (manifest.aspect || 2.8);
  let bendMm = W * 0.055;
  let straightMm = ((manifest.temple && manifest.temple.lengthMm) || 145) * 0.72;

  model.updateMatrixWorld(true);
  if (isAuto) {
    // Auto-generated 3D GLB is already centred on the nose bridge (0,0,0) with front apex at z=0.
    const frontNode = model.getObjectByName("front_frame") || model;
    const fBox = new THREE.Box3().setFromObject(frontNode);
    const fSize = fBox.getSize(new THREE.Vector3());
    const scale = fSize.x > 1e-4 ? W / fSize.x : 1000;
    model.scale.setScalar(scale);
    modelHeightMm = fSize.y > 1e-4 ? fSize.y * scale : modelHeightMm;
    face.rotation.x = PANTO_TILT;

    for (const [pivot, side] of [
      [tRight, -1],
      [tLeft, 1],
    ]) {
      pivot.rotation.x = -PANTO_TILT - TEMPLE_DROP;
      pivot.userData.side = side;
      pivot.userData.hingeX = Math.abs(pivot.position.x) * scale;
      pivots.push(pivot);
    }
  } else {
    // External uploaded GLB: auto-orient sideways exports, scale to widthMm, align nose bridge.
    let box = new THREE.Box3().setFromObject(model);
    let size = box.getSize(new THREE.Vector3());
    if (size.z > size.x * 1.15) {
      model.rotation.y = Math.PI / 2;
      model.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(model);
      size = box.getSize(new THREE.Vector3());
    }
    const scale = size.x > 1e-4 ? W / size.x : 1;
    model.scale.multiplyScalar(scale);
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const bridgeY = box.max.y - size.y * 0.42;
    model.position.set(-center.x, -bridgeY, -box.max.z);
    modelHeightMm = size.y || W / 2.8;
    straightMm = Math.max(70, (size.z || 140) * 0.72);
  }

  model.traverse((node) => {
    if (!node.isMesh) return;
    const isPad = /nose_pad/i.test(node.name);
    const isLensNode = /lens|glass/i.test(node.name);
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    let hasGlass = false;
    const nextMats = mats.map((mat) => {
      if (!mat) return mat;
      const isTransparent =
        isLensNode ||
        mat.transparent ||
        (mat.opacity !== undefined && mat.opacity < 0.98) ||
        (mat.transmission && mat.transmission > 0.05);
      if (isTransparent && !isPad) {
        hasGlass = true;
        // Upgrade glass lenses to clearcoat PBR physical material for realistic curved studio reflections.
        const phys = new THREE.MeshPhysicalMaterial({
          color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
          map: mat.map || null,
          transparent: true,
          opacity: mat.opacity !== undefined ? mat.opacity : 0.25,
          roughness: Math.min(mat.roughness ?? 0.08, 0.1),
          metalness: mat.metalness ?? 0.1,
          clearcoat: 1.0,
          clearcoatRoughness: 0.05,
          reflectivity: 0.92,
          envMapIntensity: 1.45,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        mat.dispose();
        return phys;
      }
      if ("envMapIntensity" in mat) mat.envMapIntensity = isPad ? 0.4 : 1.05;
      if (isPad) {
        mat.transparent = true;
        mat.depthWrite = false;
      }
      return mat;
    });
    node.material = Array.isArray(node.material) ? nextMats : nextMats[0];
    node.renderOrder = hasGlass ? 4 : isPad ? 2 : 3;
  });

  face.add(model);
  root.add(face);

  // Soft cast shadow on the skin when front silhouette texture is available.
  const skinShadows = new THREE.Group();
  let shadowMat = null;
  if (frontTex && frontTex.image) {
    const shadow = shadowTexture(frontTex.image);
    shadowMat = new THREE.MeshBasicMaterial({
      map: shadow.tex,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      depthTest: false,
    });
    const [ax, ay] = manifest.bridgeAnchor || [0.5, 0.45];
    const shadowMesh = new THREE.Mesh(bentPlane(W * shadow.scaleX, modelHeightMm * shadow.scaleY, bendMm, -4.2), shadowMat);
    shadowMesh.position.set(-(ax - 0.5) * W, -(0.5 - ay) * modelHeightMm - 2.2, 0);
    shadowMesh.renderOrder = 1;
    skinShadows.add(shadowMesh);
  }

  // Subtle nose-pad contact shadows ground the 3D frame onto the skin.
  const blob = blobTexture();
  const noseMat = new THREE.MeshBasicMaterial({ map: blob, transparent: true, opacity: 0.24, depthWrite: false, depthTest: false });
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(9, 15), noseMat);
    pad.position.set(side * 7.5, -9, -5);
    pad.rotation.z = side * 0.35;
    pad.renderOrder = 1;
    skinShadows.add(pad);
  }
  face.add(skinShadows);

  root.userData = {
    isGlb: true,
    widthMm: W,
    heightMm: modelHeightMm,
    bend: bendMm,
    straightMm,
    bridge: new THREE.Vector3(0, 0, 0),
    face,
    pivots,
    shadowMat,
    noseMat,
    skinShadows,
  };
  return root;
}

export async function buildGlasses(manifest) {
  if ((manifest.type === "glb" || manifest.autoGlb) && manifest.model) {
    try {
      return await buildGlbGlasses(manifest);
    } catch (err) {
      if (manifest.type === "glb" || !manifest.texture) throw err;
      // Fall back smoothly to 2.5D if an auto-generated GLB ever fails to load.
    }
  }
  const templeSides = manifest.templeSides || {};
  const templeUrls = manifest.templeTextures || {};
  const [tex, ...sideTex] = await Promise.all([
    loadTexture(manifest.texture),
    ...["left", "right"].map((side) =>
      templeSides[side] && templeUrls[side]
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

  const templeBase = manifest.temple || {};
  const hinge = manifest.hinge || { y: 0.32, heightMm: 5 };
  const frontFinish = templeBase.finish || "acetate";
  const frontMetal = frontFinish === "metal";
  const frontRimHint = hinge.heightMm || templeBase.rimMm || 3;
  const frontThick = frontMetal
    ? THREE.MathUtils.clamp(frontRimHint * 0.55, 1.3, 2.2)
    : THREE.MathUtils.clamp(frontRimHint * 0.65, 1.8, 4.4);

  const frontMat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    alphaTest: 0.06,
    side: THREE.DoubleSide,
  });
  const front = new THREE.Mesh(bentPlane(W, H, bend), frontMat);
  front.renderOrder = 4;
  face.add(front);

  // Volumetric 3D rim extrusion behind the front face (lenses excluded so glass stays single-layer).
  const rimTex = rimTexture(tex.image);
  const rimMat = new THREE.MeshStandardMaterial({
    map: rimTex,
    transparent: true,
    alphaTest: 0.45,
    roughness: frontMetal ? 0.38 : 0.55,
    metalness: frontMetal ? 0.45 : 0.04,
    envMapIntensity: 0.22,
    side: THREE.DoubleSide,
  });
  const rimLayers = Math.max(2, Math.min(7, Math.round(frontThick / 0.65)));
  for (let i = 1; i <= rimLayers; i += 1) {
    const zDepth = (i / rimLayers) * frontThick;
    const layer = new THREE.Mesh(bentPlane(W, H, bend, -zDepth), rimMat);
    // Slightly inset so back rim layers never peek above the top rim edge in frontal view.
    layer.scale.set(0.992, 0.985, 1);
    layer.renderOrder = 3;
    face.add(layer);
  }

  const [ax, ay] = manifest.bridgeAnchor || [0.5, 0.45];
  const bridge = new THREE.Vector3((ax - 0.5) * W, (0.5 - ay) * H, 0);

  // Shadows sit on the skin, so they skip the depth test against the head occluder.
  const shadow = shadowTexture(tex.image);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadow.tex,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    depthTest: false,
  });
  const shadowMesh = new THREE.Mesh(bentPlane(W * shadow.scaleX, H * shadow.scaleY, bend, -4), shadowMat);
  shadowMesh.position.y = -2.2;
  shadowMesh.renderOrder = 1;
  face.add(shadowMesh);

  const blob = blobTexture();
  const noseMat = new THREE.MeshBasicMaterial({ map: blob, transparent: true, opacity: 0.28, depthWrite: false, depthTest: false });
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(9, 15), noseMat);
    pad.position.set(bridge.x + side * 7.5, bridge.y - 9, -5);
    pad.rotation.z = side * 0.35;
    pad.renderOrder = 1;
    face.add(pad);
  }

  const glareTex = glareTexture();
  const glareMats = [];
  for (const lens of manifest.lenses || []) {
    const dark = lens.sunglass || (!lens.clear && (lens.opacity || 0) >= 0.62);
    const baseOpacity = dark ? 0.22 : 0.36;
    const glareMat = new THREE.MeshBasicMaterial({
      map: glareTex,
      transparent: true,
      opacity: baseOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    glareMat.userData.baseOpacity = baseOpacity;
    const mesh = lensGlare(lens, W, H, bend, glareMat);
    if (mesh) {
      mesh.renderOrder = 4;
      face.add(mesh);
      glareMats.push(glareMat);
    }
  }

  const pivots = [];

  // Average measured temple dimensions across sides so left and right arms are always symmetric.
  const measuredSides = ["left", "right"].map((k) => templeSides[k]).filter((s) => s && s.rimMm != null);
  const avg = (key, fallback) => {
    const vals = measuredSides.map((s) => s[key]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : fallback;
  };
  const symRim = avg("rimMm", templeBase.rimMm ?? 4);
  const symFinish = (measuredSides[0] && measuredSides[0].finish) || templeBase.finish || "acetate";
  const symMetal = symFinish === "metal";
  const symH0 = THREE.MathUtils.clamp(symRim, 1.4, 18);
  const symH1 = THREE.MathUtils.clamp(avg("tipMm", symH0 * (symMetal ? 0.68 : 0.72)), 1.2, symH0 * 1.05);
  const symThick = THREE.MathUtils.clamp(avg("thickMm", templeBase.thickMm ?? symH0 * (symMetal ? 0.5 : 0.42)), 0.9, 4.2);
  const symLength = templeBase.lengthMm || avg("lengthMm", 145);

  function sideConfig(sideKey) {
    const other = sideKey === "left" ? "right" : "left";
    const own = templeSides[sideKey] || {};
    const cfg = own.rimMm != null ? own : { ...(templeSides[other] || {}), ...own };
    const source = photoTemples[sideKey] ? sideKey : photoTemples[other] ? other : null;
    const color = cfg.color || templeBase.color || manifest.frameColor || "#222222";
    return { metal: symMetal, h0: symH0, h1: symH1, thick: symThick, length: symLength, color, source };
  }

  // Head-local +x is the wearer's left, so side +1 carries the "left" temple.
  for (const side of [-1, 1]) {
    const sideKey = side > 0 ? "left" : "right";
    const cfg = sideConfig(sideKey);
    const map = cfg.source ? templeTexture(photoTemples[cfg.source], cfg.length * 0.72, (cfg.h0 + cfg.h1) / 2) : null;
    const armMat = new THREE.MeshStandardMaterial({
      color: map ? new THREE.Color(0.82, 0.82, 0.82) : new THREE.Color(cfg.color),
      map,
      roughness: cfg.metal ? 0.24 : 0.34,
      metalness: cfg.metal ? 0.72 : 0.08,
    });
    const geo = templeGeometry(cfg.length, cfg.h0, cfg.h1, cfg.thick, side, cfg.metal);
    const pivot = new THREE.Group();
    const hingeX = W / 2 - Math.max(3.2, cfg.thick * 1.2);
    const t = hingeX / (W / 2);
    pivot.position.set(side * hingeX, (0.5 - hinge.y) * H, -bend * t * t - frontThick * 0.55);
    // Only the front carries the pantoscopic tilt; temples run back smoothly to the ears.
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
    bend,
    straightMm: armLength * 0.72,
    bridge,
    face,
    pivots,
    frontMat,
    shadowMat,
    noseMat,
    glare: { tex: glareTex, mats: glareMats },
  };
  return root;
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
  // Studio PBR IBL environment gives realistic specular reflections on metal, acetate and GLB lenses.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  if ("environmentIntensity" in scene) scene.environmentIntensity = 0.65;
  pmrem.dispose();
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8178, 1.35);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(0.35, 0.7, 1);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xeef4ff, 0.65);
  rim.position.set(-0.85, 0.35, 0.25);
  scene.add(rim);

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

  // Depth-only head: cranium ellipsoid + ear spheres + live MediaPipe face-contour mesh.
  // Together they occlude the far temple right at the user's real brow/cheek silhouette
  // without ever clipping the front lenses or the near temple.
  const head = new THREE.Group();
  head.visible = false;
  scene.add(head);
  const hiddenMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  const occluder = new THREE.Mesh(new THREE.SphereGeometry(1, 36, 24), hiddenMat);
  occluder.renderOrder = -2;
  occluder.position.set(0, -12, -92);
  head.add(occluder);
  const ears = [-1, 1].map((side) => {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), hiddenMat);
    ear.scale.set(6, 22, 11);
    ear.userData.side = side;
    ear.renderOrder = -2;
    head.add(ear);
    return ear;
  });

  // Live MediaPipe face-contour depth mesh in scene space (1 center + 36 oval vertices).
  const faceGeo = new THREE.BufferGeometry();
  const facePos = new Float32Array((1 + FACE_OVAL.length) * 3);
  const faceIdx = [];
  for (let i = 0; i < FACE_OVAL.length; i += 1) {
    faceIdx.push(0, 1 + i, 1 + ((i + 1) % FACE_OVAL.length));
  }
  faceGeo.setAttribute("position", new THREE.BufferAttribute(facePos, 3));
  faceGeo.setIndex(faceIdx);
  const faceOccluder = new THREE.Mesh(faceGeo, hiddenMat);
  faceOccluder.renderOrder = -2;
  faceOccluder.visible = false;
  faceOccluder.frustumCulled = false;
  scene.add(faceOccluder);

  // Lightweight 24×18 offscreen sampler for real-time room light & colour-temperature estimation.
  const lightCanvas = document.createElement("canvas");
  lightCanvas.width = 24;
  lightCanvas.height = 18;
  const lightCtx = lightCanvas.getContext("2d", { willReadFrequently: true });
  const lightState = { lastT: 0, luma: 0.6, r: 1, g: 1, b: 1, dirX: 0.35 };
  let lightSource = null;

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
    view: new THREE.Vector3(),
    pt: new THREE.Vector3(),
    m: new THREE.Matrix4(),
    q: new THREE.Quaternion(),
    qInv: new THREE.Quaternion(),
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
    lightSource = source;
    lightState.lastT = 0;
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
    if (glasses.userData.skinShadows) glasses.userData.skinShadows.visible = mode !== "preview";
    head.add(glasses);
    fit = { offsetY: 0, offsetZ: 0, scale: 1, ...(manifest.fit || {}) };
    applyLighting();
    if (mode === "preview") posePreview(0);
    else if (have) {
      layout(lastLayout.zFront, lastLayout.faceHalf);
      updateGlare(head.quaternion);
    }
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
    faceOccluder.visible = false;
  }

  /** Shift lens specular reflection dynamically with head yaw/pitch and room key-light side. */
  function updateGlare(quat) {
    const glare = glasses && glasses.userData.glare;
    if (!glare) return;
    tmp.view.set(0, 0, 1).applyQuaternion(tmp.qInv.copy(quat).invert());
    const offX = THREE.MathUtils.clamp(-tmp.view.x * 0.55 - lightState.dirX * 0.16, -0.42, 0.42);
    const offY = THREE.MathUtils.clamp(-tmp.view.y * 0.38, -0.32, 0.32);
    glare.tex.offset.set(offX, offY);
    const fresnel = 1 + Math.min(0.45, Math.abs(tmp.view.x) * 0.65);
    const envBoost = mode === "preview" ? 1 : THREE.MathUtils.clamp(0.75 + lightState.luma * 0.45, 0.72, 1.2);
    for (const mat of glare.mats) {
      mat.opacity = Math.min(0.55, mat.userData.baseOpacity * fresnel * envBoost);
    }
  }

  /** Estimate ambient brightness, colour temperature and key-light side from the video/photo. */
  function estimateLight(lm, now) {
    if (!lightSource || !lightCtx || (lightState.lastT && now - lightState.lastT < 250)) return;
    const sw = lightSource.videoWidth || lightSource.naturalWidth || lightSource.width || 0;
    const sh = lightSource.videoHeight || lightSource.naturalHeight || lightSource.height || 0;
    if (sw < 16 || sh < 16) return;
    try {
      lightCtx.drawImage(lightSource, 0, 0, 24, 18);
    } catch {
      return;
    }
    const data = lightCtx.getImageData(0, 0, 24, 18).data;
    const toScreenX = (p) => (mirror ? 1 - p.x : p.x);
    const xA = toScreenX(lm[LM.cheekA]);
    const xB = toScreenX(lm[LM.cheekB]);
    const fx0 = Math.max(0, Math.floor(Math.min(xA, xB) * 24));
    const fx1 = Math.min(23, Math.ceil(Math.max(xA, xB) * 24));
    const fxMid = (fx0 + fx1) / 2;
    const fy0 = Math.max(0, Math.floor(lm[LM.forehead].y * 18));
    const fy1 = Math.min(17, Math.ceil(lm[LM.subnasal].y * 18));

    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let count = 0;
    let leftLuma = 0;
    let leftN = 0;
    let rightLuma = 0;
    let rightN = 0;
    for (let py = fy0; py <= fy1; py += 1) {
      for (let px = fx0; px <= fx1; px += 1) {
        const sx = mirror ? 23 - px : px;
        const idx = (py * 24 + sx) * 4;
        const r = data[idx] / 255;
        const g = data[idx + 1] / 255;
        const b = data[idx + 2] / 255;
        const yL = 0.299 * r + 0.587 * g + 0.114 * b;
        rSum += r;
        gSum += g;
        bSum += b;
        count += 1;
        if (px < fxMid) {
          leftLuma += yL;
          leftN += 1;
        } else {
          rightLuma += yL;
          rightN += 1;
        }
      }
    }
    if (count < 4) return;
    const avgR = rSum / count;
    const avgG = gSum / count;
    const avgB = bSum / count;
    const avgLuma = THREE.MathUtils.clamp(0.299 * avgR + 0.587 * avgG + 0.114 * avgB, 0.2, 0.95);
    const meanC = Math.max(0.08, (avgR + avgG + avgB) / 3);
    const tintR = THREE.MathUtils.clamp(avgR / meanC, 0.88, 1.12);
    const tintG = THREE.MathUtils.clamp(avgG / meanC, 0.9, 1.1);
    const tintB = THREE.MathUtils.clamp(avgB / meanC, 0.86, 1.14);
    const lDiff = rightN && leftN ? (rightLuma / rightN - leftLuma / leftN) * 3.2 : 0;
    const targetDirX = THREE.MathUtils.clamp(lDiff, -0.85, 0.85);
    const a = lightState.lastT ? 0.22 : 1;
    lightState.luma += (avgLuma - lightState.luma) * a;
    lightState.r += (tintR - lightState.r) * a;
    lightState.g += (tintG - lightState.g) * a;
    lightState.b += (tintB - lightState.b) * a;
    lightState.dirX += (targetDirX - lightState.dirX) * a;
    lightState.lastT = now;

    applyLighting();
  }

  function applyLighting() {
    if (mode === "preview") {
      hemi.intensity = 1.55;
      hemi.color.setRGB(1, 1, 1);
      key.intensity = 1.45;
      key.color.setRGB(1, 1, 1);
      key.position.set(0.35, 0.7, 1);
      if (glasses && glasses.userData.frontMat) glasses.userData.frontMat.color.setRGB(1, 1, 1);
      return;
    }
    const { luma, r, g, b, dirX } = lightState;
    hemi.intensity = 1.1 + luma * 0.8;
    hemi.color.setRGB(0.55 + 0.45 * r, 0.55 + 0.45 * g, 0.55 + 0.45 * b);
    key.intensity = 0.95 + luma * 0.9;
    key.color.setRGB(r, g, b);
    key.position.set(dirX, 0.65, 1);
    if (glasses && glasses.userData.frontMat) {
      const bright = THREE.MathUtils.clamp(0.84 + luma * 0.24, 0.85, 1.05);
      glasses.userData.frontMat.color.setRGB(
        bright * (0.78 + 0.22 * r),
        bright * (0.78 + 0.22 * g),
        bright * (0.78 + 0.22 * b),
      );
    }
    if (glasses && glasses.userData.shadowMat) {
      glasses.userData.shadowMat.opacity = THREE.MathUtils.clamp(0.14 + luma * 0.14, 0.14, 0.27);
    }
  }

  /** Update the live MediaPipe face-contour depth occluder in scene space. */
  function updateFaceOccluder(lm, origin, xAxis, zAxis, pxPerMm) {
    const pos = faceGeo.attributes.position;
    // Keep the nose bridge and inner brow close to the skin so far temples hide cleanly behind
    // the eye/nose, while recessing outer cheek/temple edges so the near temple never gets notched.
    const corePush = 3.2 * pxPerMm;
    const sidePush = 9.0 * pxPerMm;
    const sideInset = 10.0 * pxPerMm;
    const p = tmp.pt;
    point(lm, LM.bridge, p).addScaledVector(zAxis, -corePush);
    pos.setXYZ(0, p.x, p.y, p.z);
    for (let i = 0; i < FACE_OVAL.length; i += 1) {
      const idx = FACE_OVAL[i];
      const isSide = SIDE_OVAL.has(idx);
      point(lm, idx, p).addScaledVector(zAxis, -(isSide ? sidePush : corePush));
      if (isSide) {
        const dx = (p.x - origin.x) * xAxis.x + (p.y - origin.y) * xAxis.y + (p.z - origin.z) * xAxis.z;
        p.addScaledVector(xAxis, -Math.sign(dx) * sideInset);
      }
      pos.setXYZ(1 + i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    faceOccluder.visible = true;
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
        faceOccluder.visible = false;
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
    layout(zFront, THREE.MathUtils.clamp(filters.ear.filter(faceHalf, dt), 60, 74));
    updateFaceOccluder(lm, head.position, x, z, head.scale.x);
    estimateLight(lm, now);
    updateGlare(head.quaternion);
    return true;
  }

  const lastLayout = { zFront: 10, faceHalf: 68 };

  /** Temples run cleanly outside the head wall; the occluder stays strictly inside them. */
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
    const zHinge = zFront + (fit.offsetZ || 0) - (u.bend || 0) * s;
    const cz = 84;
    const zc = -92;
    let occA = sideHalf - 3;
    if (u.pivots.length) {
      // Apply the exact same symmetric splay angle to both temples (both 2.5D and auto-3D GLB).
      const hx = u.pivots[0].userData.hingeX * s;
      const targetX = Math.max(sideHalf + 1.5, hx + 1);
      const splay = THREE.MathUtils.clamp(Math.atan2(targetX - hx, reach), -0.04, 0.11);
      const tanS = Math.tan(splay);
      for (const pivot of u.pivots) {
        pivot.rotation.y = -pivot.userData.side * splay;
      }
      for (const frac of [0.15, 0.42, 0.68, 0.9]) {
        const z = zc + cz * frac;
        const d = Math.max(0, zHinge - z);
        const templeX = hx + d * tanS;
        const ellipseW = Math.sqrt(Math.max(0.05, 1 - frac * frac));
        occA = Math.min(occA, (templeX - 3.5) / ellipseW);
      }
    } else if (u.isGlb) {
      occA = Math.min(occA, (u.widthMm / 2) * s - 3);
    }
    occluder.scale.set(Math.max(42, occA), 114, cz);
    for (const ear of ears) ear.position.set(ear.userData.side * (sideHalf + 5), -36, -104);
  }

  function posePreview(angle) {
    head.visible = true;
    faceOccluder.visible = false;
    head.position.set(0, 0, 0);
    head.scale.setScalar(1);
    head.quaternion.setFromEuler(new THREE.Euler(0.12, angle, 0));
    if (glasses) {
      layout(50, 66);
      updateGlare(head.quaternion);
    }
  }

  function startPreview(clear = 0xf4f2ee) {
    mode = "preview";
    bg.visible = false;
    occluder.visible = false;
    faceOccluder.visible = false;
    ears.forEach((ear) => (ear.visible = false));
    renderer.setClearColor(clear, 1);
    if (glasses) {
      glasses.userData.face.scale.x = 1;
      if (glasses.userData.skinShadows) glasses.userData.skinShadows.visible = false;
    }
    applyLighting();
    posePreview(0);
  }

  function startLive() {
    mode = "live";
    bg.visible = true;
    occluder.visible = true;
    faceOccluder.visible = false;
    ears.forEach((ear) => (ear.visible = true));
    if (glasses) {
      glasses.userData.face.scale.x = mirror ? -1 : 1;
      if (glasses.userData.skinShadows) glasses.userData.skinShadows.visible = true;
    }
    applyLighting();
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
