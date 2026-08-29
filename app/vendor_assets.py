"""Download MediaPipe browser assets onto THIS server.

Users in Azerbaijan often cannot reach jsDelivr or storage.googleapis.com.
The browser then only talks to our origin; we fetch the files once (build or
first boot) from a machine that can reach npm/Google.
"""

from __future__ import annotations

import logging
import tarfile
import tempfile
import urllib.request
from pathlib import Path

log = logging.getLogger("tryon")

STATIC_VENDOR = Path(__file__).resolve().parent / "static" / "vendor"
VENDOR = STATIC_VENDOR / "mediapipe"
WASM = VENDOR / "wasm"
DEEPAR = STATIC_VENDOR / "deepar"
DEEPAR_TGZ = "https://registry.npmjs.org/deepar/-/deepar-5.6.22.tgz"
VERSION = "0.10.21"
UNPKG = f"https://unpkg.com/@mediapipe/tasks-vision@{VERSION}"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "face_landmarker/face_landmarker/float16/1/face_landmarker.task"
)

FILES = [
    (VENDOR / "vision_bundle.mjs", f"{UNPKG}/vision_bundle.mjs", 50_000),
    (WASM / "vision_wasm_internal.js", f"{UNPKG}/wasm/vision_wasm_internal.js", 50_000),
    (WASM / "vision_wasm_internal.wasm", f"{UNPKG}/wasm/vision_wasm_internal.wasm", 1_000_000),
    (WASM / "vision_wasm_nosimd_internal.js", f"{UNPKG}/wasm/vision_wasm_nosimd_internal.js", 50_000),
    (WASM / "vision_wasm_nosimd_internal.wasm", f"{UNPKG}/wasm/vision_wasm_nosimd_internal.wasm", 1_000_000),
    (VENDOR / "face_landmarker.task", MODEL_URL, 1_000_000),
]


def _fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    log.info("Downloading %s", dest.name)
    req = urllib.request.Request(url, headers={"User-Agent": "tryon-wa/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, tmp.open("wb") as out:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
    tmp.replace(dest)


def ensure_vendor() -> None:
    for dest, url, min_size in FILES:
        if dest.exists() and dest.stat().st_size >= min_size:
            continue
        try:
            _fetch(url, dest)
        except Exception as exc:  # noqa: BLE001
            log.warning("Vendor fetch failed for %s: %s", dest.name, exc)
            if not dest.exists():
                raise
    log.info("MediaPipe vendor assets ready in %s", VENDOR)
    ensure_deepar()


def ensure_deepar() -> None:
    """Host DeepAR SDK on our origin (jsDelivr is often blocked)."""
    marker = DEEPAR / "js" / "deepar.esm.js"
    nested = DEEPAR / "package" / "js" / "deepar.esm.js"
    if marker.exists() and marker.stat().st_size > 10_000:
        return
    if nested.exists():
        log.info("Flattening DeepAR package/ layout")
        for name in (
            "js",
            "wasm",
            "models",
            "effects",
            "mediaPipe",
            "default_envmap.webp",
            "split_sum.webp",
            "package.json",
        ):
            src = DEEPAR / "package" / name
            dest = DEEPAR / name
            if src.exists() and not dest.exists():
                if src.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                    for item in src.rglob("*"):
                        rel = item.relative_to(src)
                        target = dest / rel
                        if item.is_dir():
                            target.mkdir(parents=True, exist_ok=True)
                        else:
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(item.read_bytes())
                else:
                    dest.write_bytes(src.read_bytes())
        if marker.exists():
            return
    DEEPAR.mkdir(parents=True, exist_ok=True)
    tgz = DEEPAR / "deepar.tgz"
    log.info("Downloading DeepAR SDK")
    _fetch(DEEPAR_TGZ, tgz)
    with tarfile.open(tgz, "r:gz") as tar:
        tar.extractall(DEEPAR)
    tgz.unlink(missing_ok=True)
    if nested.exists() and not marker.exists():
        ensure_deepar()
    log.info("DeepAR vendor assets ready in %s", DEEPAR)
