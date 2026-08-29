"""Face landmarks + glasses PNG overlay.

MediaPipe Face Landmarker (v1 tasks API) uses the same 468-point mesh as classic
Face Mesh. Outer eye corners 33 / 263 drive scale, rotation, and position.
Tune SKU calibration in catalog.py, not this file.
"""

from __future__ import annotations

import math
import threading
import urllib.request
from io import BytesIO
from pathlib import Path

import mediapipe as mp
import numpy as np
from PIL import Image

from app.catalog import frame_png_path, get_frame

LEFT_EYE_OUTER = 33
RIGHT_EYE_OUTER = 263

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "models"
MODEL_PATH = MODEL_DIR / "face_landmarker.task"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "face_landmarker/face_landmarker/float16/1/face_landmarker.task"
)

_landmarker = None
_lock = threading.Lock()


class NoFaceError(Exception):
    """Raised when the upload has no usable face."""


def _ensure_model() -> Path:
    if MODEL_PATH.exists() and MODEL_PATH.stat().st_size > 1_000_000:
        return MODEL_PATH
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    tmp = MODEL_PATH.with_suffix(".task.part")
    urllib.request.urlretrieve(MODEL_URL, tmp)
    tmp.replace(MODEL_PATH)
    return MODEL_PATH


def _landmarker_instance():
    global _landmarker
    if _landmarker is None:
        _ensure_model()
        _landmarker = mp.tasks.vision.FaceLandmarker.create_from_model_path(
            str(MODEL_PATH)
        )
    return _landmarker


def _landmarks_px(rgb: np.ndarray) -> tuple[tuple[float, float], tuple[float, float]]:
    # MediaPipe Image wants contiguous uint8 RGB.
    rgb = np.ascontiguousarray(rgb, dtype=np.uint8)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    h, w = rgb.shape[:2]
    with _lock:
        result = _landmarker_instance().detect(mp_image)
    if not result.face_landmarks:
        raise NoFaceError("Üz tapılmadı. Öndən, işıqlı selfie göndərin.")
    lm = result.face_landmarks[0]
    left = (lm[LEFT_EYE_OUTER].x * w, lm[LEFT_EYE_OUTER].y * h)
    right = (lm[RIGHT_EYE_OUTER].x * w, lm[RIGHT_EYE_OUTER].y * h)
    return left, right


def overlay_frame(image: Image.Image, sku: str) -> Image.Image:
    meta = get_frame(sku)
    if meta is None:
        raise ValueError(f"Naməlum eynək: {sku}")

    rgb = np.array(image.convert("RGB"))
    left, right = _landmarks_px(rgb)

    dx = right[0] - left[0]
    dy = right[1] - left[1]
    eye_dist = math.hypot(dx, dy)
    if eye_dist < 8:
        raise NoFaceError("Üz çox kiçikdir və ya şəkil bulanıqdır.")

    angle = math.degrees(math.atan2(dy, dx))
    mid = ((left[0] + right[0]) / 2, (left[1] + right[1]) / 2)
    target_w = max(8, int(eye_dist * meta["scale"]))

    glasses = Image.open(frame_png_path(sku)).convert("RGBA")
    ratio = target_w / glasses.width
    target_h = max(8, int(glasses.height * ratio))
    glasses = glasses.resize((target_w, target_h), Image.Resampling.LANCZOS)
    glasses = glasses.rotate(-angle, expand=True, resample=Image.Resampling.BICUBIC)

    nx, ny = dx / eye_dist, dy / eye_dist
    py = nx  # 90° from eye line, points down when the face is upright
    shift_x = eye_dist * meta["offset_x"]
    shift_y = eye_dist * meta["offset_y"]
    cx = mid[0] + nx * shift_x
    cy = mid[1] + ny * shift_x + py * shift_y

    paste = (int(cx - glasses.width / 2), int(cy - glasses.height / 2))
    base = image.convert("RGBA")
    base.alpha_composite(glasses, dest=paste)
    return base.convert("RGB")


def overlay_bytes(data: bytes, sku: str) -> Image.Image:
    img = Image.open(BytesIO(data))
    img.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
    return overlay_frame(img, sku)
