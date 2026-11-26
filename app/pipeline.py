"""Product photos → 2.5D try-on asset.

Front photo  → frame texture (background removed, temple tips cropped, lenses made
               translucent so eyes stay visible even through tinted lenses) plus
               millimetre geometry (lens boxes, bridge anchor, hinge height).
Side photos  → per-side temple silhouette (mm) + texture, colour/finish (3/4 or profile).
Sizes        → "49-18-142" style numbers; lens width calibrates real frame width.
"""

from __future__ import annotations

import colorsys
import logging
import os
from dataclasses import dataclass, field
from io import BytesIO

import cv2
import numpy as np
from PIL import Image, ImageOps

PIPELINE_VERSION = 16
log = logging.getLogger("vto.pipeline")
MAX_SIDE = 1600
DEFAULT_WIDTH_MM = 138.0
DEFAULT_TEMPLE_MM = 145.0
MIN_WIDTH_MM, MAX_WIDTH_MM = 100.0, 175.0
CLEAR_SHEEN_ALPHA = 10
LENS_ALPHA_MIN, LENS_ALPHA_MAX = 0.10, 0.68
LENS_GAMMA = 1.0
LENS_COLOR_KEEP = 0.42
LENS_WIDTH_FACTOR = 1.04

_REMBG_SESSION = None


class PipelineError(ValueError):
    """Photo cannot be turned into an asset; message is shown to the seller."""


@dataclass
class Sizes:
    lens_mm: float | None = None
    bridge_mm: float | None = None
    temple_mm: float | None = None
    width_mm: float | None = None


@dataclass
class Asset:
    front: Image.Image
    manifest: dict
    sides: dict[str, Image.Image] = field(default_factory=dict)
    temple_strips: dict[str, Image.Image] = field(default_factory=dict)
    glb: bytes | None = None


def load_image(data: bytes) -> Image.Image:
    try:
        img = ImageOps.exif_transpose(Image.open(BytesIO(data)))
    except Exception as exc:  # noqa: BLE001
        raise PipelineError("Şəkil oxunmadı (JPG, PNG və ya WEBP yükləyin).") from exc
    img = img.convert("RGBA")
    scale = MAX_SIDE / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    return img


def _hex(rgb) -> str:
    r, g, b = (int(np.clip(c, 0, 255)) for c in rgb[:3])
    return f"#{r:02x}{g:02x}{b:02x}"


def _border_pixels(rgb: np.ndarray) -> np.ndarray:
    h, w = rgb.shape[:2]
    b = max(2, int(min(h, w) * 0.02))
    return np.concatenate(
        [rgb[:b].reshape(-1, 3), rgb[-b:].reshape(-1, 3), rgb[:, :b].reshape(-1, 3), rgb[:, -b:].reshape(-1, 3)]
    ).astype(np.float32)


def _cut_uniform(px: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Matte against a flat backdrop and strip the backdrop colour out of edge pixels."""
    rgb = px[..., :3].astype(np.float32)
    dist = np.linalg.norm(rgb - bg, axis=2)
    ramp = np.clip((dist - 26) / 32, 0, 1)
    solid = (dist > 90).astype(np.float32)
    sigma = max(2.0, max(px.shape[:2]) * 0.004)
    weight = cv2.GaussianBlur(solid, (0, 0), sigma)
    fg = cv2.GaussianBlur(rgb * solid[..., None], (0, 0), sigma) / np.maximum(weight, 1e-4)[..., None]
    near = weight > 0.02
    fg = np.where(near[..., None], fg, rgb)
    span = fg - bg
    span_sq = (span**2).sum(axis=2)
    projected = np.clip(((rgb - bg) * span).sum(axis=2) / np.maximum(span_sq, 1.0), 0, 1)
    usable = near & (span_sq > 90**2) & (solid == 0)
    alpha = np.where(usable, projected, ramp)
    alpha = np.where(alpha < 0.06, 0, alpha)
    edge = usable & (alpha < 0.98)
    out = px.copy()
    out[..., :3] = np.where(edge[..., None], np.clip(fg, 0, 255), rgb).astype(np.uint8)
    out[..., 3] = (alpha * 255).astype(np.uint8)
    return out


def _rembg(img: Image.Image) -> np.ndarray:
    global _REMBG_SESSION
    from rembg import new_session, remove

    if _REMBG_SESSION is None:
        model = os.environ.get("VTO_REMBG_MODEL", "isnet-general-use").strip() or "isnet-general-use"
        try:
            _REMBG_SESSION = new_session(model)
        except Exception:  # noqa: BLE001
            _REMBG_SESSION = new_session("u2net")
    return np.array(remove(img, session=_REMBG_SESSION).convert("RGBA"))


def remove_background(img: Image.Image) -> tuple[np.ndarray, str]:
    px = np.array(img)
    if (px[..., 3] < 10).mean() > 0.05:
        return px, "alpha"
    border = _border_pixels(px[..., :3])
    bg = np.median(border, axis=0)
    spread = np.linalg.norm(border - bg, axis=1)
    if np.percentile(spread, 90) < 18:
        return _cut_uniform(px, bg), "uniform"
    try:
        return _rembg(img), "rembg"
    except Exception:  # noqa: BLE001
        return _cut_uniform(px, bg), "uniform-fallback"


def _drop_specks(px: np.ndarray) -> np.ndarray:
    mask = (px[..., 3] > 40).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if n <= 2:
        return px
    total = stats[1:, cv2.CC_STAT_AREA].sum()
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= max(40, total * 0.0015)
    out = px.copy()
    out[..., 3] = np.where(keep[labels] | (labels == 0), out[..., 3], 0)
    return out


def _crop_alpha(px: np.ndarray, pad: int = 2) -> np.ndarray:
    ys, xs = np.nonzero(px[..., 3] > 20)
    if len(xs) == 0:
        raise PipelineError("Şəkildə eynək tapılmadı. Ağ və ya sadə fonda çəkin.")
    h, w = px.shape[:2]
    return px[max(0, ys.min() - pad) : min(h, ys.max() + pad + 1), max(0, xs.min() - pad) : min(w, xs.max() + pad + 1)]


def _crop_temple_tips(px: np.ndarray) -> np.ndarray:
    """Front shots often show thin temple ends beyond the hinges; cut them off."""
    h, w = px.shape[:2]
    solid = px[..., 3] > 60
    any_rows = solid.any(axis=0)
    top = np.where(any_rows, solid.argmax(axis=0), 0)
    bottom = np.where(any_rows, h - 1 - solid[::-1].argmax(axis=0), 0)
    extent = np.convolve(np.where(any_rows, bottom - top + 1, 0).astype(np.float32), np.ones(5) / 5, "same")
    thick = extent >= h * 0.06
    zone = int(w * 0.14)
    x0 = next((x for x in range(zone) if thick[x]), 0)
    x1 = next((x for x in range(w - 1, w - 1 - zone, -1) if thick[x]), w - 1)
    return _crop_alpha(px[:, x0 : x1 + 1])


def _crop_temple_stubs(px: np.ndarray) -> np.ndarray:
    """Temples seen in perspective or folded behind the rim stick up above the outer top line; trim them."""
    h, w = px.shape[:2]
    solid = px[..., 3] > 90
    cols = solid.any(axis=0)
    top = np.where(cols, solid.argmax(axis=0), h).astype(np.float32)
    out = px.copy()
    zone = int(w * 0.22)
    for ref_cols, zone_cols, is_left in (
        (np.arange(int(w * 0.22), int(w * 0.36)), np.arange(0, zone), True),
        (np.arange(int(w * 0.64), int(w * 0.78)), np.arange(w - zone, w), False),
    ):
        ref = top[ref_cols]
        ok = ref < h
        if ok.sum() < 5:
            continue
        slope, icept = np.polyfit(ref_cols[ok], ref[ok], 1)
        # Preserve genuine upward-sweeping cat-eye frames (steep outward rise along ref_cols).
        outward_rise = -slope if is_left else slope
        if outward_rise < -0.18:
            continue
        line = slope * zone_cols + icept - h * 0.008
        protruding = top[zone_cols] < line - h * 0.012
        if protruding.sum() < max(3, int(w * 0.005)):
            continue
        rows = np.arange(h, dtype=np.float32)[:, None]
        keep = np.clip(rows - line[None, :] + 1.5, 0, 1)
        out[:, zone_cols, 3] = (out[:, zone_cols, 3] * keep).astype(np.uint8)
    return _crop_alpha(out)


def _fill_holes(mask: np.ndarray) -> np.ndarray:
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = np.zeros(mask.shape, np.uint8)
    cv2.drawContours(out, contours, -1, 1, -1)
    return out.astype(bool)


def _bridge_column(mask: np.ndarray) -> int:
    w = mask.shape[1]
    lo, hi = int(w * 0.36), int(w * 0.64)
    cols = np.convolve(mask.sum(axis=0).astype(np.float32), np.ones(7) / 7, "same")
    return lo + int(np.argmin(cols[lo:hi]))


def _lens_blobs(alpha: np.ndarray) -> tuple[list[np.ndarray], int]:
    h, w = alpha.shape
    opaque = alpha > 100
    filled = _fill_holes(opaque)
    split = _bridge_column(opaque)
    filled[:, max(0, split - 2) : split + 3] = False
    k = max(5, int(w * 0.07)) | 1
    opened = cv2.morphologyEx(
        filled.astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    )
    blobs = []
    for x0, x1 in ((0, split), (split, w)):
        part = np.zeros_like(opened)
        part[:, x0:x1] = opened[:, x0:x1]
        n, labels, stats, _ = cv2.connectedComponentsWithStats(part, 8)
        if n <= 1:
            continue
        idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        if stats[idx, cv2.CC_STAT_AREA] < 0.015 * h * w:
            continue
        blobs.append(labels == idx)
    return blobs, split


def _lens_interior(blob: np.ndarray, px: np.ndarray, width: int) -> tuple[np.ndarray, bool]:
    alpha = px[..., 3]
    inner = cv2.erode(blob.astype(np.uint8), np.ones((5, 5), np.uint8), iterations=2).astype(bool)
    trans = inner & (alpha < 40)
    if trans.sum() > 0.25 * blob.sum():
        hull = cv2.convexHull(cv2.findNonZero(trans.astype(np.uint8)))
        interior = np.zeros(blob.shape, np.uint8)
        cv2.fillPoly(interior, [hull], 1)
        return interior.astype(bool) & blob, True
    dt = cv2.distanceTransform(blob.astype(np.uint8), cv2.DIST_L2, 5)
    rgb = px[..., :3].astype(np.float32)
    core = dt > dt.max() * 0.6
    lens_rgb = np.median(rgb[core], axis=0)
    close = (np.linalg.norm(rgb - lens_rgb, axis=2) < 34) & (dt > max(2.0, width * 0.006))
    close = cv2.morphologyEx(close.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, labels = cv2.connectedComponents(close, 8)
    if n <= 1:
        return np.zeros(blob.shape, bool), False
    counts = np.bincount(labels[core & (labels > 0)], minlength=n)
    seed = int(np.argmax(counts)) if counts.any() else 1 + int(np.argmax(np.bincount(labels[labels > 0])[1:]))
    areas = np.bincount(labels.ravel(), minlength=n)
    pieces = [i for i in range(1, n) if i == seed or areas[i] > 0.15 * areas[seed]]
    region = np.isin(labels, pieces).astype(np.uint8)
    rim = blob & (dt < max(2.0, dt.max() * 0.12)) & (px[..., 3] > 200)
    if rim.sum() > 30:
        rim_rgb = np.median(rgb[rim], axis=0)
        allowed = (blob & (np.linalg.norm(rgb - rim_rgb, axis=2) > 20)).astype(np.uint8)
        # Temples seen through a tinted lens break it into pieces; the hull bridges them.
        hull = np.zeros(blob.shape, np.uint8)
        cv2.fillPoly(hull, [cv2.convexHull(cv2.findNonZero(region))], 1)
        region = hull & allowed
        cross = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
        for _ in range(max(3, int(width * 0.03))):
            grown = cv2.dilate(region, cross) & allowed
            if (grown == region).all():
                break
            region = grown
    k = max(5, int(width * 0.02)) | 1
    region = cv2.morphologyEx(region, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    interior = _fill_holes(region.astype(bool)) & blob
    rim_guard = max(2.5, float(dt.max()) * 0.13)
    interior = interior & (dt > rim_guard)
    return interior, False


def _polygon(mask: np.ndarray, w: int, h: int) -> list[list[float]]:
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return []
    cnt = max(contours, key=cv2.contourArea)
    approx = cv2.approxPolyDP(cnt, 0.006 * cv2.arcLength(cnt, True), True).reshape(-1, 2)
    return [[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in approx]


def _smooth_tint(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Low-order colour field over the lens: keeps the tint gradient, drops whatever the photo
    showed through or on the lens (temples, logos, reflections)."""
    ys, xs = np.nonzero(mask)
    h, w = mask.shape
    u, v = xs / w, ys / h
    basis = np.stack([np.ones_like(u), u, v, u * u, u * v, v * v], axis=1)
    target = rgb[ys, xs]
    keep = np.ones(len(xs), bool)
    for _ in range(3):
        coef, *_ = np.linalg.lstsq(basis[keep], target[keep], rcond=None)
        resid = np.linalg.norm(target - basis @ coef, axis=1)
        keep = resid < max(6.0, 2.0 * float(np.median(resid[keep])) * 1.4826)
    yy, xx = np.mgrid[0:h, 0:w]
    uu, vv = xx / w, yy / h
    field = np.stack([np.ones_like(uu), uu, vv, uu * uu, uu * vv, vv * vv], axis=2) @ coef
    return np.where(mask[..., None], np.clip(field, 0, 255), rgb).astype(np.float32)


def _lens_is_sunglass(rgb: np.ndarray, interior: np.ndarray) -> bool:
    if interior.sum() < 20:
        return False
    med = np.median(rgb[interior], axis=0)
    return float(np.mean(med)) < 72 and float(np.max(med)) < 110


def _apply_lenses(px: np.ndarray) -> tuple[np.ndarray, list[dict], list[np.ndarray], int]:
    h, w = px.shape[:2]
    out = px.astype(np.float32)
    blobs, split = _lens_blobs(px[..., 3])
    items: list[tuple[dict, np.ndarray]] = []
    for blob in blobs:
        interior, clear = _lens_interior(blob, px, w)
        if interior.sum() < 0.01 * h * w:
            continue
        sunglass = False
        weight = cv2.GaussianBlur(interior.astype(np.float32), (0, 0), max(1.0, w * 0.0025)) * interior
        weight = weight[..., None]
        rgb = out[..., :3]
        alpha = out[..., 3:4]
        if clear:
            target_rgb = np.array([236, 240, 246], np.float32)
            target_a = np.full_like(alpha, CLEAR_SHEEN_ALPHA)
            tint = "#f0f4f8"
            opacity = CLEAR_SHEEN_ALPHA / 255
        else:
            # A tinted lens filters light (face × transmission); capping opacity keeps eyes
            # subtly visible even on dark sunglasses so they look like glass, not solid paint.
            rgb = _smooth_tint(rgb, interior)
            sunglass = _lens_is_sunglass(rgb, interior)
            transmission = np.power(rgb / 255, LENS_GAMMA)
            lens_a = np.clip(1 - transmission.mean(axis=2, keepdims=True), LENS_ALPHA_MIN, LENS_ALPHA_MAX)
            target_rgb = rgb * LENS_COLOR_KEEP
            target_a = lens_a * 255
            tint = _hex(np.median(rgb[interior], axis=0))
            opacity = round(float(np.median(target_a[interior])) / 255, 3)
        out[..., :3] = rgb * (1 - weight) + target_rgb * weight
        out[..., 3:4] = alpha * (1 - weight) + target_a * weight
        ys, xs = np.nonzero(interior)
        outer_x = np.nonzero(blob.any(axis=0))[0]
        items.append(
            (
                {
                    "outerWidth": round(float(outer_x.max() - outer_x.min() + 1) / w, 4),
                    "center": [round(float(xs.mean()) / w, 4), round(float(ys.mean()) / h, 4)],
                    "box": [
                        round(float(xs.min()) / w, 4),
                        round(float(ys.min()) / h, 4),
                        round(float(xs.max() - xs.min() + 1) / w, 4),
                        round(float(ys.max() - ys.min() + 1) / h, 4),
                    ],
                    "polygon": _polygon(interior, w, h),
                    "clear": clear,
                    "sunglass": sunglass if not clear else False,
                    "tint": tint,
                    "opacity": opacity,
                },
                interior,
            )
        )
    items.sort(key=lambda pair: pair[0]["center"][0])
    lenses = [pair[0] for pair in items]
    interiors = [pair[1] for pair in items]
    return np.clip(out, 0, 255).astype(np.uint8), lenses, interiors, split


def _hinge(alpha: np.ndarray) -> tuple[float, float]:
    h, w = alpha.shape
    band = max(3, int(w * 0.03))
    ys_all, hs = [], []
    for cols in (alpha[:, :band], alpha[:, w - band :]):
        ys = np.nonzero((cols > 100).any(axis=1))[0]
        if len(ys):
            ys_all.append((ys.min() + ys.max()) / 2)
            hs.append(ys.max() - ys.min() + 1)
    if not ys_all:
        return 0.32, 0.08
    return float(np.mean(ys_all)) / h, float(np.mean(hs)) / h


def _frame_rim_mm(px: np.ndarray, width_mm: float, finish: str) -> tuple[float, float]:
    """Rim height and extrusion depth (mm) from front alpha — thin vs thick frames."""
    h, w = px.shape[:2]
    mm = width_mm / w
    opaque = (px[..., 3] > 200).astype(np.uint8)
    dt = cv2.distanceTransform(opaque, cv2.DIST_L2, 5)
    band = max(5, int(w * 0.07))
    samples: list[float] = []
    for x in list(range(band)) + list(range(w - band, w)):
        col = dt[:, x]
        vals = col[(col > 0.8) & (col < dt.max() * 0.55)]
        if vals.size:
            samples.append(float(np.percentile(vals, 72)))
    rim_px = float(np.median(samples)) if samples else h * 0.042
    rim_mm = float(np.clip(rim_px * mm * 1.08, 1.6, 11.0))
    metal = finish == "metal"
    thick_mm = float(np.clip(rim_mm * (0.4 if metal else 0.58), 0.75, 4.0))
    return rim_mm, thick_mm


def _refine_alpha_edges(px: np.ndarray) -> np.ndarray:
    """Drop fuzzy halos; keep a crisp frame edge."""
    out = px.copy()
    a = out[..., 3].astype(np.float32)
    a = cv2.GaussianBlur(a, (0, 0), 0.55)
    strong = a > 210
    weak = (a > 48) & (a <= 210)
    a = np.where(strong, 255, np.where(weak, a, 0))
    mask = (a > 200).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    a = np.where(mask > 0, np.maximum(a, mask.astype(np.float32) * 255), 0)
    out[..., 3] = np.clip(a, 0, 255).astype(np.uint8)
    return out


def _median_color(px: np.ndarray, mask: np.ndarray, fallback: str) -> str:
    sel = mask & (px[..., 3] > 200)
    if sel.sum() < 30:
        return fallback
    return _hex(np.median(px[..., :3][sel], axis=0))


def _finish(px: np.ndarray, mask: np.ndarray) -> str:
    sel = mask & (px[..., 3] > 200)
    if sel.sum() < 30:
        return "acetate"
    rgb = px[..., :3][sel].astype(np.float32)
    r, g, b = np.median(rgb, axis=0) / 255
    _, sat, val = colorsys.rgb_to_hsv(r, g, b)
    spread = float(rgb.mean(axis=1).std())
    return "metal" if sat < 0.18 and val > 0.35 and spread > 28 else "acetate"


def _temple_region(px: np.ndarray) -> np.ndarray:
    """Far end of a side/3-4 shot is the temple tip (the front is heavier)."""
    ys, xs = np.nonzero(px[..., 3] > 120)
    mask = np.zeros(px.shape[:2], bool)
    if len(xs) < 50:
        return mask
    cx, span = xs.mean(), xs.max() - xs.min()
    right = (xs.max() - cx) > (cx - xs.min())
    sel = xs > xs.max() - span * 0.16 if right else xs < xs.min() + span * 0.16
    mask[ys[sel], xs[sel]] = True
    return mask


def _trace_arm(alpha: np.ndarray) -> tuple[list[tuple[int, int, int]], bool] | None:
    """Follow the temple from its tip towards the frame, one column at a time.

    Each column keeps the opaque run closest to the arm's centre line, so the far temple
    showing above it in a 3/4 shot is ignored. The trace stops where the run suddenly gets
    much taller than the arm: that is the end piece / rim, i.e. the hinge.
    """
    h, _ = alpha.shape
    ys, xs = np.nonzero(alpha)
    if len(xs) < 200:
        return None
    x_min, x_max = int(xs.min()), int(xs.max())
    span = x_max - x_min + 1
    cx = float(xs.mean())
    tip_right = (x_max - cx) > (cx - x_min)
    start, step = (x_max, -1) if tip_right else (x_min, 1)
    runs: list[tuple[int, int, int]] = []
    heights: list[int] = []
    center = None
    x = start
    while x_min <= x <= x_max:
        idx = np.flatnonzero(alpha[:, x])
        if not len(idx):
            if runs:
                break
            x += step
            continue
        cut = np.flatnonzero(np.diff(idx) > 1)
        starts = np.r_[idx[0], idx[cut + 1]]
        ends = np.r_[idx[cut], idx[-1]]
        if center is None:
            k = int(np.argmax(ends - starts))
        else:
            k = int(np.argmin(np.abs((starts + ends) / 2 - center)))
        top, bot = int(starts[k]), int(ends[k])
        height = bot - top + 1
        if len(heights) >= 8 and abs(x - start) > 0.2 * span:
            med = float(np.median(heights))
            if height > max(1.7 * med, med + 0.03 * h):
                break
        runs.append((x, top, bot))
        heights.append(height)
        mid = (top + bot) / 2
        center = mid if center is None else 0.6 * center + 0.4 * mid
        x += step
    if len(runs) < 0.25 * span:
        return None
    return runs[::-1], tip_right


def _smooth(values: np.ndarray, k: int = 5) -> np.ndarray:
    if len(values) < k:
        return values.astype(np.float32)
    pad = k // 2
    padded = np.pad(values.astype(np.float32), pad, mode="edge")
    return np.convolve(padded, np.ones(k) / k, "valid")


def _temple_profile(px: np.ndarray, frame_h_mm: float, temple_mm: float) -> dict | None:
    """Measure real temple dimensions (mm) and optional straight-section texture from a side/3-4 photo.

    Vertical height is immune to horizontal foreshortening in 3/4 shots, so scaling by the
    frame height seen in the same photo gives accurate thin-vs-thick temple proportions.
    We build smooth 3D geometry on the client from these measurements instead of extruding
    raw foreshortened pixel silhouettes (which distort the hinge and ear hook).
    """
    raw = px[..., 3] > 120
    alpha = raw | _fill_holes(raw)
    h, w = alpha.shape
    traced = _trace_arm(alpha)
    if not traced:
        return None
    runs, tip_right = traced
    hinge_x = runs[0][0]
    arm_len = len(runs)
    heights = np.array([b - t + 1 for _, t, b in runs], np.float32)

    cols = alpha.any(axis=0)
    first = np.where(cols, alpha.argmax(axis=0), 0)
    last = np.where(cols, h - 1 - alpha[::-1].argmax(axis=0), 0)
    extent = np.where(cols, last - first + 1, 0)
    front = extent[:hinge_x] if tip_right else extent[hinge_x + 1 :]
    front = front[front > 0]
    if len(front) < 5:
        return None
    frame_px = float(np.median(front))
    if frame_px < 2.0 * float(np.median(heights)):
        return None

    sy = frame_h_mm / frame_px
    i0 = arm_len * 12 // 100
    i1 = max(i0 + 3, arm_len * 36 // 100)
    i2 = arm_len * 45 // 100
    i3 = max(i2 + 3, arm_len * 72 // 100)
    hinge_mm = float(np.median(heights[i0:i1])) * sy
    mid_mm = float(np.median(heights[i2:i3])) * sy
    if not 0.8 <= hinge_mm <= 20:
        return None
    hinge_mm = float(np.clip(hinge_mm, 1.4, 18.0))
    mid_mm = float(np.clip(mid_mm, 1.2, hinge_mm * 1.05))

    # Core mask along the straight run avoids anti-aliased border halos when sampling colour.
    core_mask = np.zeros((h, w), bool)
    for x, top, bot in runs[i0:i3]:
        pad = max(1, (bot - top) // 4)
        t_in, b_in = min(top + pad, bot), max(bot - pad, top)
        core_mask[t_in : b_in + 1, x] = True

    # Only attach a straight-section texture when the temple is wide enough to show a visible
    # logo or pattern (e.g. thick acetate / tortoise); solid thin temples render cleaner in 3D.
    texture = None
    core_rgb = px[..., :3][core_mask & (px[..., 3] > 200)]
    if hinge_mm >= 5.5 and len(core_rgb) >= 60:
        luma = core_rgb.mean(axis=1)
        contrast = float(np.percentile(luma, 98) - np.percentile(luma, 8))
        if contrast > 55:
            seg = runs[i0:i3]
            seg_len = len(seg)
            seg_idx = np.arange(seg_len)
            centers = np.array([(t + b) / 2 for _, t, b in seg], np.float32)
            slope = float(np.polyfit(seg_idx, centers, 1)[0])
            shift = np.round(slope * seg_idx).astype(int)
            tops = np.array([t for _, t, _ in seg]) - shift
            bots = np.array([b for _, _, b in seg]) - shift
            r0 = int(np.percentile(tops, 15))
            r1 = int(np.percentile(bots, 85))
            if r1 - r0 >= 8:
                rows = np.arange(r0, r1 + 1)
                tex = np.zeros((r1 - r0 + 1, seg_len, 4), np.uint8)
                for i, (x, top, bot) in enumerate(seg):
                    inner_t, inner_b = min(top + 1, bot), max(bot - 1, top)
                    tex[:, i] = px[np.clip(rows + shift[i], inner_t, inner_b), x]
                tex[..., 3] = 255
                texture = Image.fromarray(tex, "RGBA")

    return {
        "side": "left" if tip_right else "right",
        "texture": texture,
        "mask": core_mask,
        "hingeMm": hinge_mm,
        "midMm": mid_mm,
    }


def _temple_thick(hinge_mm: float, finish: str) -> float:
    if finish == "metal":
        return float(np.clip(hinge_mm * 0.55, 0.9, 1.8))
    return float(np.clip(hinge_mm * 0.42, 1.2, 4.2))


def analyze_side(img: Image.Image, frame_h_mm: float, temple_mm: float) -> tuple[Image.Image, dict]:
    px, _ = remove_background(img)
    px = _crop_alpha(_drop_specks(px))
    found = _temple_profile(px, frame_h_mm, temple_mm)
    region = found["mask"] if found else _temple_region(px)
    finish = _finish(px, region)
    info = {"color": _median_color(px, region, ""), "finish": finish, "lengthMm": float(temple_mm)}
    if found:
        info.update(
            side=found["side"],
            rimMm=round(found["hingeMm"], 2),
            tipMm=round(found["midMm"], 2),
            thickMm=round(_temple_thick(found["hingeMm"], finish), 2),
            source="photo",
        )
        if found["texture"] is not None:
            info["texture"] = found["texture"]
    else:
        info["source"] = "photo-color"
    return Image.fromarray(px, "RGBA"), info


def _width_from_lens(lenses: list[dict], lens_mm: float | None) -> float | None:
    if not lens_mm or not lenses:
        return None
    lens_frac = float(np.mean([lens["box"][2] for lens in lenses])) * LENS_WIDTH_FACTOR
    if lens_frac <= 0:
        return None
    width = lens_mm / lens_frac
    return width if MIN_WIDTH_MM <= width <= MAX_WIDTH_MM else None


def resolve_width(lenses: list[dict], sizes: Sizes) -> tuple[float, str]:
    if sizes.width_mm and MIN_WIDTH_MM <= sizes.width_mm <= MAX_WIDTH_MM:
        return float(sizes.width_mm), "given"
    measured = _width_from_lens(lenses, sizes.lens_mm)
    if measured:
        return measured, "lens"
    if sizes.lens_mm and sizes.bridge_mm:
        return float(np.clip(2 * sizes.lens_mm + sizes.bridge_mm + 12, MIN_WIDTH_MM, MAX_WIDTH_MM)), "sizes"
    return DEFAULT_WIDTH_MM, "default"


def build_asset(front: Image.Image, sides: dict[str, Image.Image], sizes: Sizes) -> Asset:
    px, bg_method = remove_background(front)
    px = _crop_temple_stubs(_crop_temple_tips(_crop_alpha(_drop_specks(px))))
    h, w = px.shape[:2]
    if w < 120 or w / max(h, 1) < 1.2:
        raise PipelineError("Ön şəkil düz öndən olmalıdır: eynək tam görünsün, yan bucaqdan yox.")
    px = _refine_alpha_edges(px)
    px, lenses, lens_interiors, split = _apply_lenses(px)
    if len(lenses) == 2:
        (wa, wb) = (lenses[0]["box"][2], lenses[1]["box"][2])
        mid = (lenses[0]["center"][0] + lenses[1]["center"][0]) / 2
        if min(wa, wb) / max(wa, wb) < 0.78 or abs(mid - 0.5) > 0.08:
            raise PipelineError("Ön şəkil bucaq altında çəkilib. Eynəyi düz öndən çəkin: iki linza eyni ölçüdə görünməlidir.")
    warnings = [] if len(lenses) == 2 else ["lenses"]
    width_mm, width_source = resolve_width(lenses, sizes)
    mm_per_px = width_mm / w
    hinge_y, _ = _hinge(px[..., 3])

    lens_mask = np.zeros((h, w), np.uint8)
    for lens in lenses:
        poly = np.array([[x * w, y * h] for x, y in lens["polygon"]], np.int32)
        if len(poly) >= 3:
            cv2.fillPoly(lens_mask, [poly], 1)
    frame_mask = (px[..., 3] > 200) & (lens_mask == 0)
    frame_color = _median_color(px, frame_mask, "#222222")
    temple_mm = sizes.temple_mm if sizes.temple_mm and 110 <= sizes.temple_mm <= 170 else DEFAULT_TEMPLE_MM

    side_images, analysed = {}, []
    for name, img in sides.items():
        cut, info = analyze_side(img, h * mm_per_px, temple_mm)
        side_images[name] = cut
        analysed.append((name, info))
    # The photo's orientation tells which temple it shows; the upload label only breaks ties.
    side_info, temple_strips = {}, {}
    for name, info in sorted(analysed, key=lambda item: item[1].get("side") != item[0]):
        side = info.pop("side", None) or name
        texture = info.pop("texture", None)
        if side in side_info:
            continue
        side_info[side] = info
        if texture is not None:
            temple_strips[side] = texture
            info["texture"] = f"temple-{side}.png"
    temple_colors = [i["color"] for i in side_info.values() if i["color"]]
    edge = np.zeros((h, w), bool)
    band = max(3, int(w * 0.04))
    edge[:, :band] = True
    edge[:, w - band :] = True
    temple_color = temple_colors[0] if temple_colors else _median_color(px, edge, frame_color)
    finishes = [i["finish"] for i in side_info.values()]
    temple_finish = max(set(finishes), key=finishes.count) if finishes else _finish(px, edge)
    rim_mm, _ = _frame_rim_mm(px, width_mm, temple_finish)
    temple_h = float(np.clip(rim_mm * 0.85, 1.4, 9.0))
    thick_mm = _temple_thick(temple_h, temple_finish)

    if len(lenses) == 2:
        bridge = [
            round((lenses[0]["center"][0] + lenses[1]["center"][0]) / 2, 4),
            round((lenses[0]["center"][1] + lenses[1]["center"][1]) / 2, 4),
        ]
    else:
        bridge = [round(split / w, 4), 0.42]

    temple_sides = {}
    for name, info in side_info.items():
        keys = ("color", "finish", "rimMm", "tipMm", "thickMm", "lengthMm", "source", "texture")
        temple_sides[name] = {k: info[k] for k in keys if k in info}
    if len(temple_sides) == 1:
        warnings.append("temple_one_side")
    if not temple_sides:
        warnings.append("temple_no_side_photos")
    manifest = {
        "type": "2.5d",
        "pipeline": PIPELINE_VERSION,
        "widthMm": round(width_mm, 2),
        "heightMm": round(h * mm_per_px, 2),
        "aspect": round(w / h, 4),
        "widthSource": width_source,
        "bridgeAnchor": bridge,
        "lenses": lenses,
        "hinge": {"y": round(hinge_y, 4), "heightMm": round(rim_mm, 2)},
        "frameColor": frame_color,
        "temple": {
            "lengthMm": float(temple_mm),
            "color": temple_color,
            "finish": temple_finish,
            "rimMm": round(temple_h, 2),
            "thickMm": round(thick_mm, 2),
        },
        "templeSides": temple_sides,
        "sizes": {"lens": sizes.lens_mm, "bridge": sizes.bridge_mm, "temple": sizes.temple_mm},
        "background": bg_method,
        "warnings": warnings,
    }
    glb_bytes: bytes | None = None
    try:
        from app.glb_gen import generate_eyewear_glb

        glb_bytes = generate_eyewear_glb(px, lens_interiors, manifest, temple_strips)
        if glb_bytes:
            manifest["autoGlb"] = True
            manifest["renderMode"] = "2.5d"
    except Exception as exc:  # noqa: BLE001
        log.warning("Auto 3D GLB generation skipped: %s", exc)
    return Asset(
        front=Image.fromarray(px, "RGBA"),
        manifest=manifest,
        sides=side_images,
        temple_strips=temple_strips,
        glb=glb_bytes,
    )


def parse_sizes(text: str | None) -> Sizes:
    """Accepts '49-18-142', '49□18 142', '49 18 142'."""
    if not text:
        return Sizes()
    nums = [float(n) for n in "".join(ch if ch.isdigit() or ch == "." else " " for ch in text).split()]
    nums = [n for n in nums if 8 <= n <= 180]
    sizes = Sizes()
    if len(nums) >= 1 and 30 <= nums[0] <= 70:
        sizes.lens_mm = nums[0]
    if len(nums) >= 2 and 10 <= nums[1] <= 30:
        sizes.bridge_mm = nums[1]
    if len(nums) >= 3 and 110 <= nums[2] <= 170:
        sizes.temple_mm = nums[2]
    return sizes
