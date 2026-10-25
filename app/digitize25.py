"""Eynək fotosundan 2.5D VTO asseti: rembg + linza deşikləri + manifest."""

from __future__ import annotations

import json
import time
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
VTO25_DIR = ROOT / "data" / "vto25"
VTO25_DIR.mkdir(parents=True, exist_ok=True)

_REMBG_SESSION = None
MIN_HOLE_AREA = 800
LENS_TINT_DEFAULT = "#202020"
BRIDGE_FALLBACK = [0.5, 0.4]


def _cut_by_corners(img: Image.Image) -> Image.Image:
    rgba = img.convert("RGBA")
    px = np.array(rgba)
    h, w = px.shape[:2]
    corners = np.array(
        [
            px[2, 2, :3],
            px[2, w - 3, :3],
            px[h - 3, 2, :3],
            px[h - 3, w - 3, :3],
            px[2, w // 2, :3],
        ],
        dtype=np.float32,
    )
    bg = corners.mean(axis=0)
    rgb = px[:, :, :3].astype(np.float32)
    dist = np.linalg.norm(rgb - bg, axis=2)
    lum = rgb.mean(axis=2)
    alpha = px[:, :, 3].astype(np.float32)
    alpha[dist < 40] = 0
    fade = (dist >= 40) & (dist < 68)
    alpha[fade] *= (dist[fade] - 40) / 28
    alpha[lum > 247] = 0
    px[:, :, 3] = np.clip(alpha, 0, 255).astype(np.uint8)
    return Image.fromarray(px, "RGBA")


def remove_background(img: Image.Image) -> Image.Image:
    global _REMBG_SESSION
    try:
        from rembg import new_session, remove

        if _REMBG_SESSION is None:
            _REMBG_SESSION = new_session("u2net")
        return remove(img.convert("RGBA"), session=_REMBG_SESSION)
    except Exception:
        return _cut_by_corners(img)


def crop_to_alpha(img: Image.Image) -> Image.Image:
    bbox = img.getchannel("A").getbbox()
    return img.crop(bbox) if bbox else img


def _holes_cv2(alpha: np.ndarray):
    import cv2

    transparent = np.where(alpha < 128, 255, 0).astype(np.uint8)
    contours, hierarchy = cv2.findContours(transparent, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []
    holes = []
    for i, cnt in enumerate(contours):
        if hierarchy[0][i][3] == -1:
            continue
        if cv2.contourArea(cnt) < MIN_HOLE_AREA:
            continue
        holes.append(cnt)
    holes.sort(key=cv2.contourArea, reverse=True)
    return holes[:2]


def _holes_numpy(alpha: np.ndarray):
    h, w = alpha.shape
    empty = alpha < 128
    vis = np.zeros_like(empty, dtype=bool)
    holes = []
    for y in range(h):
        for x in range(w):
            if not empty[y, x] or vis[y, x]:
                continue
            stack = [(x, y)]
            vis[y, x] = True
            cells = []
            border = False
            while stack:
                cx, cy = stack.pop()
                cells.append((cx, cy))
                if cx == 0 or cy == 0 or cx == w - 1 or cy == h - 1:
                    border = True
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= nx < w and 0 <= ny < h and empty[ny, nx] and not vis[ny, nx]:
                        vis[ny, nx] = True
                        stack.append((nx, ny))
            if border or len(cells) < MIN_HOLE_AREA:
                continue
            pts = np.array(cells, dtype=np.int32).reshape(-1, 1, 2)
            holes.append(pts)
    holes.sort(key=lambda c: len(c), reverse=True)
    return holes[:2]


def find_lens_holes(alpha: np.ndarray):
    try:
        return _holes_cv2(alpha)
    except Exception:
        return _holes_numpy(alpha)


def _contour_center(cnt) -> tuple[float, float]:
    pts = np.asarray(cnt).reshape(-1, 2)
    if len(pts) == 0:
        return 0.0, 0.0
    return float(pts[:, 0].mean()), float(pts[:, 1].mean())


def bridge_anchor(alpha: np.ndarray) -> list[float]:
    h, w = alpha.shape
    holes = find_lens_holes(alpha)
    if len(holes) < 2:
        return BRIDGE_FALLBACK
    c1, c2 = (_contour_center(c) for c in holes[:2])
    return [round((c1[0] + c2[0]) / 2 / w, 4), round((c1[1] + c2[1]) / 2 / h, 4)]


def lens_polygons(alpha: np.ndarray) -> list:
    h, w = alpha.shape
    polys = []
    try:
        import cv2

        for cnt in find_lens_holes(alpha):
            approx = cv2.approxPolyDP(cnt, 0.01 * cv2.arcLength(cnt, True), True)
            pts = approx.reshape(-1, 2)
            polys.append([[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in pts])
    except Exception:
        for cnt in find_lens_holes(alpha):
            pts = np.asarray(cnt).reshape(-1, 2)
            step = max(1, len(pts) // 16)
            sample = pts[::step]
            polys.append([[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in sample])
    return polys


def frame_color(rgba: np.ndarray) -> str:
    alpha = rgba[..., 3]
    try:
        import cv2

        opaque = (alpha > 200).astype(np.uint8)
        kernel = np.ones((5, 5), np.uint8)
        border = opaque - cv2.erode(opaque, kernel)
        mask = border > 0
    except Exception:
        mask = alpha > 200
    if int(mask.sum()) < 50:
        mask = alpha > 200
    rgb = rgba[..., :3][mask].astype(np.float32)
    if len(rgb) == 0:
        return "#222222"
    lum = rgb.mean(axis=1)
    dark = rgb[lum <= np.median(lum)]
    mean = dark.mean(axis=0) if len(dark) else rgb.mean(axis=0)
    return "#{:02x}{:02x}{:02x}".format(int(mean[0]), int(mean[1]), int(mean[2]))


def sample_lens_tint(rgba: np.ndarray) -> str:
    alpha = rgba[..., 3]
    mid = (alpha > 8) & (alpha < 90)
    if int(mid.sum()) < 30:
        return LENS_TINT_DEFAULT
    c = rgba[..., :3][mid].mean(axis=0)
    return "#{:02x}{:02x}{:02x}".format(int(c[0]), int(c[1]), int(c[2]))


def crop_temple_tips(img: Image.Image) -> Image.Image:
    """İncə yan qolları kəs — ön çərçivə qalsın."""
    px = np.array(img)
    a = px[:, :, 3] > 20
    col = a.sum(axis=0).astype(np.float32)
    if col.max() < 8:
        return img
    keep = col > col.max() * 0.38
    if int(keep.sum()) < 8:
        return img
    xs = np.where(keep)[0]
    pad = max(2, int((xs.max() - xs.min()) * 0.015))
    x0 = max(0, int(xs.min()) - pad)
    x1 = min(px.shape[1] - 1, int(xs.max()) + pad)
    return crop_to_alpha(img.crop((x0, 0, x1 + 1, img.size[1])))


def clear_lens_interiors(img: Image.Image) -> Image.Image:
    """Linza içinə düşən qol/fon izlərini sil — deşik şəffaf qalsın."""
    px = np.array(img)
    holes = find_lens_holes(px[:, :, 3])
    if not holes:
        return img
    try:
        import cv2

        for cnt in holes:
            cv2.drawContours(px, [np.asarray(cnt).reshape(-1, 1, 2).astype(np.int32)], -1, (0, 0, 0, 0), -1)
    except Exception:
        for cnt in holes:
            pts = np.asarray(cnt).reshape(-1, 2)
            if len(pts) < 3:
                continue
            x0, y0 = pts.min(axis=0)
            x1, y1 = pts.max(axis=0)
            px[int(y0) : int(y1) + 1, int(x0) : int(x1) + 1, 3] = np.minimum(
                px[int(y0) : int(y1) + 1, int(x0) : int(x1) + 1, 3],
                0,
            )
    return Image.fromarray(px, "RGBA")


def prepare(photo: Image.Image, width_mm: float = 140, out_id: str | None = None) -> dict:
    out_id = out_id or f"g{int(time.time() * 1000)}"
    folder = VTO25_DIR / out_id
    folder.mkdir(parents=True, exist_ok=True)
    cut = clear_lens_interiors(crop_temple_tips(crop_to_alpha(remove_background(photo))))
    cut.save(folder / "texture.png", "PNG")
    rgba = np.array(cut)
    alpha = rgba[..., 3]
    h, w = alpha.shape
    manifest = {
        "id": out_id,
        "type": "2.5d",
        "texture": f"/vto25/{out_id}/texture.png",
        "widthMm": float(width_mm),
        "aspect": round(w / max(1, h), 4),
        "bridgeAnchor": bridge_anchor(alpha),
        "frameColor": frame_color(rgba),
        "lensTint": sample_lens_tint(rgba),
        "lensPolygons": lens_polygons(alpha),
    }
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def prepare_bytes(data: bytes, width_mm: float = 140, filename: str = "glasses.png") -> dict:
    img = Image.open(BytesIO(data)).convert("RGBA")
    stem = Path(filename).stem[:24] or "g"
    safe = "".join(ch for ch in stem if ch.isalnum() or ch in "-_") or "g"
    return prepare(img, width_mm=width_mm, out_id=f"{safe}-{int(time.time())}")


def load_manifest(out_id: str) -> dict | None:
    path = VTO25_DIR / out_id / "manifest.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
