"""Download MediaPipe browser assets onto THIS server.

Users in Azerbaijan often cannot reach jsDelivr or storage.googleapis.com.
The browser then only talks to our origin; we fetch the files once (build or
first boot) from a machine that can reach npm/Google.
"""

from __future__ import annotations

import logging
import urllib.request
from pathlib import Path

log = logging.getLogger("tryon")

VENDOR = Path(__file__).resolve().parent / "static" / "vendor" / "mediapipe"
WASM = VENDOR / "wasm"
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
