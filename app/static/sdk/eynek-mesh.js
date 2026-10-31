/**
 * Product photo → 3D glasses mesh (front texture + generated temples).
 * three.js MIT. This is glasses-specific digitize, not generic Meshy/Tripo.
 */
import * as THREE from "three";

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
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const edge = x < w * 0.12 || x > w * 0.88 || y < h * 0.16 || y > h * 0.84;
      if (!edge || lum > 220) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
  }
  if (!n) return 0x1a1a1a;
  return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
}

function bendFront(geom, amount = 0.055) {
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    pos.setZ(i, pos.getZ(i) - x * x * amount * 4);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
}

function sideTemple(cutout, sign) {
  if (!cutout) return null;
  const aspect = cutout.height / cutout.width;
  const tex = new THREE.CanvasTexture(cutout);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const w = 0.22;
  const h = w * aspect;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.06,
      roughness: 0.36,
      metalness: 0.12,
      side: THREE.FrontSide,
    }),
  );
  mesh.name = "side-temple";
  mesh.userData.sideTemple = true;
  mesh.userData.templeSide = sign;
  mesh.position.set(sign * 0.52, aspect * 0.05, -0.2);
  mesh.rotation.y = -sign * (Math.PI / 2 - 0.12);
  mesh.rotation.x = -0.08;
  return mesh;
}

export function buildGlasses3D(cutoutCanvas, opts = {}) {
  const aspect = cutoutCanvas.height / cutoutCanvas.width;
  const rim = sampleRimColor(cutoutCanvas);
  const group = new THREE.Group();
  group.name = "digitized-glasses";
  const frameMm = opts.frameWidthMm || 140;
  group.userData.frameWidthCm = frameMm / 10;
  group.userData.digitizedPhoto = true;

  const tex = new THREE.CanvasTexture(cutoutCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  const frontGeom = new THREE.PlaneGeometry(1, aspect, 16, 8);
  bendFront(frontGeom, 0.068);
  const front = new THREE.Mesh(
    frontGeom,
    new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.04,
      roughness: 0.32,
      metalness: 0.16,
      side: THREE.FrontSide,
      depthWrite: true,
    }),
  );
  front.position.z = 0.02;
  group.add(front);

  const templeMat = new THREE.MeshStandardMaterial({
    color: rim,
    roughness: 0.38,
    metalness: 0.22,
  });
  const hingeY = aspect * 0.06;
  const templeLen = 0.58;
  const templeGeom = new THREE.CapsuleGeometry(0.018, templeLen, 4, 8);
  templeGeom.rotateX(Math.PI / 2);

  const left = new THREE.Mesh(templeGeom, templeMat);
  left.userData.templeCapsule = true;
  left.userData.templeSide = -1;
  left.position.set(-0.485, hingeY, -templeLen / 2);
  left.rotation.y = 0.1;
  const right = new THREE.Mesh(templeGeom, templeMat);
  right.userData.templeCapsule = true;
  right.userData.templeSide = 1;
  right.position.set(0.485, hingeY, -templeLen / 2);
  right.rotation.y = -0.1;
  group.add(left, right);

  const hookGeom = new THREE.CapsuleGeometry(0.016, 0.14, 4, 8);
  hookGeom.rotateX(Math.PI / 2);
  const leftHook = new THREE.Mesh(hookGeom, templeMat);
  leftHook.userData.templeCapsule = true;
  leftHook.userData.templeSide = -1;
  leftHook.userData.hook = true;
  leftHook.position.set(-0.5, hingeY - 0.04, -templeLen - 0.02);
  leftHook.rotation.x = 0.55;
  const rightHook = new THREE.Mesh(hookGeom, templeMat);
  rightHook.userData.templeCapsule = true;
  rightHook.userData.templeSide = 1;
  rightHook.userData.hook = true;
  rightHook.position.set(0.5, hingeY - 0.04, -templeLen - 0.02);
  rightHook.rotation.x = 0.55;
  group.add(leftHook, rightHook);

  if (opts.leftCanvas) {
    const sideL = sideTemple(opts.leftCanvas, -1);
    if (sideL) group.add(sideL);
  }
  if (opts.rightCanvas) {
    const sideR = sideTemple(opts.rightCanvas, 1);
    if (sideR) group.add(sideR);
  }

  return group;
}
