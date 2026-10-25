/**
 * 3D VTO scene: video/photo + digitized glasses + head occluder.
 * One WebGL view so the overlay cannot drift off the face.
 */
import * as THREE from "three";

function toVec(p, width, height, mirror) {
  if (!p) return null;
  return new THREE.Vector3(
    (mirror ? 1 - p.x : p.x) * width - width / 2,
    (0.5 - p.y) * height,
    -(p.z || 0) * width,
  );
}

export function createVto3D(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: false,
    antialias: true,
  });
  renderer.setClearColor(0x111111, 1);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
  camera.position.z = 1200;

  const bgGeom = new THREE.PlaneGeometry(1, 1);
  const bgMat = new THREE.MeshBasicMaterial({ depthWrite: false });
  const bg = new THREE.Mesh(bgGeom, bgMat);
  bg.position.z = -200;
  bg.renderOrder = -2;
  scene.add(bg);

  scene.add(new THREE.AmbientLight(0xffffff, 0.78));
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(-0.35, 0.65, 1);
  scene.add(key);

  const head = new THREE.Group();
  scene.add(head);

  const occluder = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 18),
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  occluder.renderOrder = -1;
  occluder.position.set(0, -0.08, -0.62);
  occluder.scale.set(0.52, 0.78, 0.32);
  head.add(occluder);

  let glasses = null;
  let viewW = 1;
  let viewH = 1;
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
    camera.left = -viewW / 2;
    camera.right = viewW / 2;
    camera.top = viewH / 2;
    camera.bottom = -viewH / 2;
    camera.updateProjectionMatrix();
    bg.scale.set(viewW, viewH, 1);
  }

  function setBackground(source, mirror) {
    if (!source) return;
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
    }
    bgMat.map = tex;
    bgMat.needsUpdate = true;
  }

  function setGlasses(object) {
    if (glasses) {
      head.remove(glasses);
      glasses.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        const mats = child.material
          ? (Array.isArray(child.material) ? child.material : [child.material])
          : [];
        mats.forEach((mat) => {
          if (mat.map) mat.map.dispose();
          mat.dispose();
        });
      });
    }
    glasses = object;
    if (glasses) head.add(glasses);
  }

  function place(pose, width, height, opts = {}) {
    if (!glasses || !pose || !pose.left || !pose.right) return false;
    const scale = opts.scale ?? 1.28;
    const offsetY = opts.offsetY ?? 0.02;
    const mirror = !!opts.mirror;

    const left = toVec(pose.left, width, height, mirror);
    const right = toVec(pose.right, width, height, mirror);
    const bridge = toVec(pose.bridge || pose.nose, width, height, mirror);
    const nose = toVec(pose.nose, width, height, mirror);
    if (!left || !right) return false;

    const xAxis = right.clone().sub(left);
    const dist = xAxis.length();
    if (dist < 10) return false;
    xAxis.normalize();

    const mid = left.clone().add(right).multiplyScalar(0.5);
    if (bridge) {
      mid.x = bridge.x;
      mid.z = (mid.z + bridge.z) / 2;
    }
    mid.y += dist * offsetY;

    const upHint = new THREE.Vector3(0, 1, 0);
    const zAxis = new THREE.Vector3().crossVectors(xAxis, upHint);
    if (zAxis.lengthSq() < 1e-8) zAxis.set(0, 0, 1);
    zAxis.normalize();
    if (zAxis.z < 0) zAxis.negate();
    if (nose) {
      const yaw = (nose.x - mid.x) / dist;
      zAxis.x += yaw * 0.45;
      zAxis.normalize();
    }
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    zAxis.crossVectors(xAxis, yAxis).normalize();

    const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
    const pos = mid.add(zAxis.clone().multiplyScalar(dist * 0.05));
    const scl = dist * scale;

    const t = smooth.ready ? 0.38 : 1;
    smooth.pos.lerp(pos, t);
    smooth.quat.slerp(quat, t);
    smooth.scale += (scl - smooth.scale) * t;
    smooth.ready = true;

    head.position.copy(smooth.pos);
    head.quaternion.copy(smooth.quat);
    head.scale.setScalar(smooth.scale);
    glasses.position.set(0, 0, 0);
    glasses.quaternion.identity();
    glasses.scale.setScalar(1);
    return true;
  }

  function resetSmooth() {
    smooth.ready = false;
  }

  function render() {
    if (bgMat.map) bgMat.map.needsUpdate = true;
    renderer.render(scene, camera);
  }

  function clear() {
    renderer.clear();
  }

  return { resize, setBackground, setGlasses, place, render, clear, resetSmooth };
}
