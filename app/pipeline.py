"""Product photos → 2.5D try-on asset.

Front photo  → frame texture (background removed, temple tips cropped, lenses made
               translucent so eyes stay visible even through tinted lenses) plus
               millimetre geometry (lens boxes, bridge anchor, hinge height).
Side photos  → temple colour/finish (3/4 or profile shots both work).
Sizes        → "49-18-142" style numbers; lens width calibrates real frame width.
"""

from __future__ import annotations

import colorsys
from dataclasses import dataclass, field
from io import BytesIO

import cv2
import numpy as np
from PIL import Image, ImageOps

PIPELINE_VERSION = 4
MAX_SIDE = 1600
DEFAULT_WIDTH_MM = 138.0
DEFAULT_TEMPLE_MM = 145.0
MIN_WIDTH_MM, MAX_WIDTH_MM = 100.0, 175.0
CLEAR_SHEEN_ALPHA = 10
LENS_ALPHA_MIN, LENS_ALPHA_MAX = 0.10, 0.74
LENS_GAMMA = 1.0
LENS_COLOR_KEEP = 0.45
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
    """Temples seen in perspective stick up above the end pieces; trim to the frame's top line."""
    h, w = px.shape[:2]
    solid = px[..., 3] > 128
    cols = solid.any(axis=0)
    top = np.where(cols, solid.argmax(axis=0), h).astype(np.float32)
    out = px.copy()
    zone = int(w * 0.16)
    for ref_cols, zone_cols in (
        (np.arange(int(w * 0.16), int(w * 0.30)), np.arange(0, zone)),
        (np.arange(int(w * 0.70), int(w * 0.84)), np.arange(w - zone, w)),
    ):
        ref = top[ref_cols]
        ok = ref < h
        if ok.sum() < 5:
            continue
        slope, icept = np.polyfit(ref_cols[ok], ref[ok], 1)
        line = slope * zone_cols + icept - h * 0.015
        if (top[zone_cols] < line - h * 0.04).sum() < w * 0.02:
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


def _apply_lenses(px: np.ndarray) -> tuple[np.ndarray, list[dict], int]:
    h, w = px.shape[:2]
    out = px.astype(np.float32)
    blobs, split = _lens_blobs(px[..., 3])
    lenses = []
    for blob in blobs:
        interior, clear = _lens_interior(blob, px, w)
        if interior.sum() < 0.01 * h * w:
            continue
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
            # A tinted lens filters light (face × transmission); with plain alpha blending that is
            # a dark layer whose opacity is 1 − transmission; the cap keeps eyes visible.
            rgb = _smooth_tint(rgb, interior)
            transmission = np.power(rgb / 255, LENS_GAMMA)
            lens_a = np.clip(1 - transmission.mean(axis=2, keepdims=True), LENS_ALPHA_MIN, LENS_ALPHA_MAX)
            target_rgb = rgb * LENS_COLOR_KEEP
            target_a = lens_a * 255
            tint = _hex(np.median(px[..., :3][interior], axis=0))
            opacity = round(float(np.median(target_a[interior])) / 255, 3)
        out[..., :3] = rgb * (1 - weight) + target_rgb * weight
        out[..., 3:4] = alpha * (1 - weight) + target_a * weight
        ys, xs = np.nonzero(interior)
        outer_x = np.nonzero(blob.any(axis=0))[0]
        lenses.append(
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
                "tint": tint,
                "opacity": opacity,
            }
        )
    lenses.sort(key=lambda lens: lens["center"][0])
    return np.clip(out, 0, 255).astype(np.uint8), lenses, split


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
    return float(np.mean(ys_all)) / h, float(np.mean(hs)) / w


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


def analyze_side(img: Image.Image) -> tuple[Image.Image, dict]:
    px, _ = remove_background(img)
    px = _crop_alpha(_drop_specks(px))
    region = _temple_region(px)
    return Image.fromarray(px, "RGBA"), {
        "color": _median_color(px, region, ""),
        "finish": _finish(px, region),
    }


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
    px, lenses, split = _apply_lenses(px)
    if len(lenses) == 2:
        (wa, wb) = (lenses[0]["box"][2], lenses[1]["box"][2])
        mid = (lenses[0]["center"][0] + lenses[1]["center"][0]) / 2
        if min(wa, wb) / max(wa, wb) < 0.78 or abs(mid - 0.5) > 0.08:
            raise PipelineError("Ön şəkil bucaq altında çəkilib. Eynəyi düz öndən çəkin: iki linza eyni ölçüdə görünməlidir.")
    warnings = [] if len(lenses) == 2 else ["lenses"]
    width_mm, width_source = resolve_width(lenses, sizes)
    mm_per_px = width_mm / w
    hinge_y, hinge_h = _hinge(px[..., 3])

    lens_mask = np.zeros((h, w), np.uint8)
    for lens in lenses:
        poly = np.array([[x * w, y * h] for x, y in lens["polygon"]], np.int32)
        if len(poly) >= 3:
            cv2.fillPoly(lens_mask, [poly], 1)
    frame_mask = (px[..., 3] > 200) & (lens_mask == 0)
    frame_color = _median_color(px, frame_mask, "#222222")

    side_info, side_images = {}, {}
    for name, img in sides.items():
        cut, info = analyze_side(img)
        side_images[name] = cut
        side_info[name] = info
    temple_colors = [i["color"] for i in side_info.values() if i["color"]]
    edge = np.zeros((h, w), bool)
    band = max(3, int(w * 0.04))
    edge[:, :band] = True
    edge[:, w - band :] = True
    temple_color = temple_colors[0] if temple_colors else _median_color(px, edge, frame_color)
    finishes = [i["finish"] for i in side_info.values()]
    temple_finish = max(set(finishes), key=finishes.count) if finishes else _finish(px, edge)

    if len(lenses) == 2:
        bridge = [
            round((lenses[0]["center"][0] + lenses[1]["center"][0]) / 2, 4),
            round((lenses[0]["center"][1] + lenses[1]["center"][1]) / 2, 4),
        ]
    else:
        bridge = [round(split / w, 4), 0.42]

    temple_mm = sizes.temple_mm if sizes.temple_mm and 110 <= sizes.temple_mm <= 170 else DEFAULT_TEMPLE_MM
    manifest = {
        "type": "2.5d",
        "pipeline": PIPELINE_VERSION,
        "widthMm": round(width_mm, 2),
        "heightMm": round(h * mm_per_px, 2),
        "aspect": round(w / h, 4),
        "widthSource": width_source,
        "bridgeAnchor": bridge,
        "lenses": lenses,
        "hinge": {"y": round(hinge_y, 4), "heightMm": round(float(np.clip(hinge_h * width_mm, 2.5, 14)), 2)},
        "frameColor": frame_color,
        "temple": {"lengthMm": float(temple_mm), "color": temple_color, "finish": temple_finish},
        "sizes": {"lens": sizes.lens_mm, "bridge": sizes.bridge_mm, "temple": sizes.temple_mm},
        "background": bg_method,
        "warnings": warnings,
    }
    return Asset(front=Image.fromarray(px, "RGBA"), manifest=manifest, sides=side_images)


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
