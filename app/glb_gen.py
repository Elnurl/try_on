"""Automatic Stock Photo → True 3D .glb Eyewear Generator.

Turns a seller's front (+ optional side) eyewear product photos and pipeline
measurements into a standalone, glTF 2.0 binary (.glb) 3D model in real-world
metres:
  - Beveled solid 3D front frame mesh (extruded from the exact frame silhouette
    with lens openings cut out, wrapped with realistic base-curve, front/side/back
    UV-mapped to an edge-bleed-free texture so tortoiseshell/two-tone/rim details
    carry cleanly around the 3D edges).
  - Curved 3D PBR glass lenses (tinted or clear, tucked cleanly into the rim).
  - Subtle 3D translucent nose pads & delicate metallic pad arms on optical frames.
  - Strictly symmetric 3D ergonomic beveled temples under named pivot nodes
    (`temple_left`, `temple_right`) with metallic hinge accents, so VTO can
    dynamically splay the temples to each user's real head width while the file
    also opens cleanly as a standard 3D model in Blender / Three.js / AR viewers.
"""

from __future__ import annotations

import json
import math
import struct
from io import BytesIO

import cv2
import mapbox_earcut as earcut
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from scipy.spatial import Delaunay

MM_TO_M = 0.001


def _hex_to_rgb01(hex_color: str, fallback: tuple[float, float, float] = (0.14, 0.14, 0.14)) -> tuple[float, float, float]:
    s = (hex_color or "").strip().lstrip("#")
    if len(s) != 6:
        return fallback
    try:
        return (int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0)
    except ValueError:
        return fallback


def _srgb_to_linear(c: float) -> float:
    c = max(0.0, min(1.0, float(c)))
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _rgb_to_linear(rgb: tuple[float, float, float]) -> list[float]:
    return [_srgb_to_linear(rgb[0]), _srgb_to_linear(rgb[1]), _srgb_to_linear(rgb[2])]


def _png_bytes(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _inpaint_frame_texture(px: np.ndarray, frame_mask: np.ndarray, max_w: int = 768) -> bytes:
    """Fill non-frame and anti-aliased edge pixels from the deep opaque core of the rim
    so 3D bevels, side walls and mipmaps never pick up white background halos or flash glare."""
    rgb = px[..., :3].astype(np.float32)
    a = px[..., 3]
    luma = rgb.mean(axis=2)
    dt = cv2.distanceTransform(frame_mask.astype(np.uint8), cv2.DIST_L2, 5)
    vals = dt[frame_mask]
    core_min = float(np.clip(np.percentile(vals, 38), 1.8, 4.5)) if vals.size else 1.8
    src = frame_mask & (a >= 245) & (dt >= core_min)
    if src.sum() < 80:
        src = frame_mask & (a >= 230) & (dt >= 1.2)
    if src.sum() < 40:
        src = frame_mask

    # Drop bright studio-flash / white-halo / silver-pad outliers from the dilation seeds on dark frames
    # so a single bright pixel on the edge cannot spray white streaks across the 3D rim walls.
    if src.any():
        med_luma = float(np.median(luma[src]))
        if med_luma < 115.0:
            clean = src & (luma <= med_luma + 48.0)
            if clean.sum() >= 60:
                src = clean
        iy, ix = distance_transform_edt(~src, return_distances=False, return_indices=True)
        dilated = rgb[iy, ix]
        # Keep authentic interior colours on the deep core; replace thin halo borders with clean core colour.
        keep_orig = src & (dt >= max(2.2, core_min))
        filled = np.where(keep_orig[..., None], rgb, dilated)
    else:
        filled = rgb

    img = Image.fromarray(np.clip(filled, 0, 255).astype(np.uint8), "RGB")
    if img.width > max_w:
        nh = max(16, round(img.height * (max_w / img.width)))
        img = img.resize((max_w, nh), Image.LANCZOS)
    return _png_bytes(img)


def _signed_area(pts: np.ndarray) -> float:
    x = pts[:, 0]
    y = pts[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _smooth_loop(pts: np.ndarray, weight: float = 0.22, passes: int = 2) -> np.ndarray:
    out = pts.astype(np.float64).copy()
    if len(out) < 5:
        return out
    for _ in range(passes):
        prev_p = np.roll(out, 1, axis=0)
        next_p = np.roll(out, -1, axis=0)
        out = (1.0 - weight) * out + (weight * 0.5) * (prev_p + next_p)
    return out


def _chaikin_loop(pts: np.ndarray, passes: int = 1) -> np.ndarray:
    """Quadratic B-spline corner cutting: turns polygonal rim contours into silky smooth curves."""
    out = pts.astype(np.float64)
    for _ in range(passes):
        if len(out) < 4 or len(out) > 220:
            break
        nxt = np.roll(out, -1, axis=0)
        q = 0.75 * out + 0.25 * nxt
        r = 0.25 * out + 0.75 * nxt
        out = np.empty((len(out) * 2, 2), dtype=np.float64)
        out[0::2] = q
        out[1::2] = r
    return out


def _subdivide_loop(pts: np.ndarray, max_seg_mm: float = 3.5) -> np.ndarray:
    """Split long straight segments so wraparound curvature stays smooth."""
    res: list[np.ndarray] = []
    n = len(pts)
    for i in range(n):
        a = pts[i]
        b = pts[(i + 1) % n]
        res.append(a)
        d = float(np.linalg.norm(b - a))
        if d > max_seg_mm:
            steps = int(math.ceil(d / max_seg_mm))
            for k in range(1, steps):
                t = k / steps
                res.append(a * (1.0 - t) + b * t)
    return np.asarray(res, dtype=np.float64)


def _dedup_loop(pts: np.ndarray, tol: float = 0.05) -> np.ndarray:
    if len(pts) < 3:
        return pts
    keep = [pts[0]]
    for p in pts[1:]:
        if float(np.linalg.norm(p - keep[-1])) > tol:
            keep.append(p)
    while len(keep) > 3 and float(np.linalg.norm(keep[-1] - keep[0])) <= tol:
        keep.pop()
    return np.asarray(keep, dtype=np.float64)


def _z_wrap(x_mm: np.ndarray | float, half_w: float, bend_mm: float) -> np.ndarray | float:
    t = x_mm / max(half_w, 1.0)
    return -bend_mm * (t * t)


def _dz_dx(x_mm: np.ndarray | float, half_w: float, bend_mm: float) -> np.ndarray | float:
    return -2.0 * bend_mm * x_mm / max(half_w * half_w, 1.0)


def _front_normal(x_mm: np.ndarray, half_w: float, bend_mm: float, sign: float = 1.0) -> np.ndarray:
    slope = _dz_dx(x_mm, half_w, bend_mm)
    nx = -slope * sign
    ny = np.zeros_like(nx)
    nz = np.full_like(nx, sign)
    norms = np.stack([nx, ny, nz], axis=1)
    lens = np.linalg.norm(norms, axis=1, keepdims=True)
    return (norms / np.maximum(lens, 1e-6)).astype(np.float32)


def _loop_outward_normals_2d(pts: np.ndarray) -> np.ndarray:
    """Outward unit 2D normal at each vertex (CCW outer -> outward, CW hole -> into hole)."""
    n = len(pts)
    nxt = np.roll(pts, -1, axis=0)
    prv = np.roll(pts, 1, axis=0)
    e1 = pts - prv
    e2 = nxt - pts
    l1 = np.maximum(np.linalg.norm(e1, axis=1, keepdims=True), 1e-6)
    l2 = np.maximum(np.linalg.norm(e2, axis=1, keepdims=True), 1e-6)
    t1 = e1 / l1
    t2 = e2 / l2
    # Right-hand perpendicular (t.y, -t.x) points outward for CCW outer & CW holes.
    n1 = np.stack([t1[:, 1], -t1[:, 0]], axis=1)
    n2 = np.stack([t2[:, 1], -t2[:, 0]], axis=1)
    avg = n1 + n2
    al = np.linalg.norm(avg, axis=1, keepdims=True)
    return np.where(al > 1e-4, avg / np.maximum(al, 1e-4), n2)


def _build_front_frame_mesh(
    frame_mask: np.ndarray,
    w_mm: float,
    h_mm: float,
    bridge_xy: tuple[float, float],
    bend_mm: float,
    thick_mm: float,
) -> dict | None:
    """Build a watertight, curved, beveled 3D solid front frame mesh with UVs."""
    h, w = frame_mask.shape
    half_w = w_mm * 0.5
    bx_mm = (bridge_xy[0] - 0.5) * w_mm
    by_mm = (0.5 - bridge_xy[1]) * h_mm

    # Distance transform (mm) for safe per-vertex bevel clamping on thin metal rims.
    dt_px = cv2.distanceTransform(frame_mask.astype(np.uint8), cv2.DIST_L2, 5)
    mm_per_px = w_mm / max(w, 1)

    # 2x supersampled mask turns pixel staircases into silky smooth curves.
    up = cv2.resize(frame_mask.astype(np.float32), (w * 2, h * 2), interpolation=cv2.INTER_LINEAR)
    up = cv2.GaussianBlur(up, (0, 0), 1.1)
    mask_2x = (up > 0.45).astype(np.uint8)
    contours, hierarchy = cv2.findContours(mask_2x, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if not contours or hierarchy is None:
        return None
    hier = hierarchy[0]

    def px2x_to_mm(cnt: np.ndarray) -> np.ndarray:
        raw = cnt.reshape(-1, 2).astype(np.float64) * 0.5
        u = raw[:, 0] / max(w - 1, 1)
        v = raw[:, 1] / max(h - 1, 1)
        x = (u - 0.5) * w_mm - bx_mm
        y = (0.5 - v) * h_mm - by_mm
        return np.stack([x, y], axis=1)

    def mm_to_uv(xy: np.ndarray) -> np.ndarray:
        u = np.clip((xy[:, 0] + bx_mm) / max(w_mm, 1e-3) + 0.5, 0.001, 0.999)
        v = np.clip(0.5 - (xy[:, 1] + by_mm) / max(h_mm, 1e-3), 0.001, 0.999)
        return np.stack([u, v], axis=1).astype(np.float32)

    def sample_half_w_mm(xy: np.ndarray) -> np.ndarray:
        uv = mm_to_uv(xy)
        px_x = np.clip(np.round(uv[:, 0] * (w - 1)).astype(int), 0, w - 1)
        px_y = np.clip(np.round(uv[:, 1] * (h - 1)).astype(int), 0, h - 1)
        # Sample in a small 3x3 neighbourhood max so boundary points see interior thickness.
        vals = dt_px[px_y, px_x]
        if w > 4 and h > 4:
            vals = np.maximum(vals, dt_px[np.clip(px_y - 1, 0, h - 1), px_x])
            vals = np.maximum(vals, dt_px[np.clip(px_y + 1, 0, h - 1), px_x])
            vals = np.maximum(vals, dt_px[px_y, np.clip(px_x - 1, 0, w - 1)])
            vals = np.maximum(vals, dt_px[px_y, np.clip(px_x + 1, 0, w - 1)])
        return vals * mm_per_px

    def clean_contour(cnt: np.ndarray, want_ccw: bool) -> np.ndarray | None:
        perim = cv2.arcLength(cnt, True)
        if perim < 16:
            return None
        # Fixed sub-pixel tolerance (1.5 px on 2x mask = 0.75 original px) avoids octagonal facets on round rims.
        eps = min(2.2, max(1.1, 0.00035 * perim))
        approx = cv2.approxPolyDP(cnt, eps, True)
        if len(approx) < 3:
            return None
        pts = px2x_to_mm(approx)
        pts = _chaikin_loop(pts, passes=1)
        pts = _smooth_loop(pts, weight=0.22, passes=2)
        pts = _subdivide_loop(pts, max_seg_mm=3.0)
        pts = _dedup_loop(pts, tol=0.14)
        if len(pts) < 3:
            return None
        area = _signed_area(pts)
        if abs(area) < 1.5:
            return None
        if (area > 0) != want_ccw:
            pts = pts[::-1].copy()
        return pts

    all_pos: list[np.ndarray] = []
    all_nrm: list[np.ndarray] = []
    all_uv: list[np.ndarray] = []
    all_col: list[np.ndarray] = []
    all_idx: list[np.ndarray] = []
    v_offset = 0

    def push(pos: np.ndarray, nrm: np.ndarray, uv: np.ndarray, col_val: float, idx: np.ndarray) -> None:
        nonlocal v_offset
        if len(pos) == 0 or len(idx) == 0:
            return
        all_pos.append(pos.astype(np.float32))
        all_nrm.append(nrm.astype(np.float32))
        all_uv.append(uv.astype(np.float32))
        all_col.append(np.full((len(pos), 3), col_val, dtype=np.float32))
        all_idx.append((idx.astype(np.uint32) + v_offset))
        v_offset += len(pos)

    bevel_z = min(0.45, thick_mm * 0.22)
    bevel_in_max = min(0.32, thick_mm * 0.14)

    for i, cnt in enumerate(contours):
        if hier[i][3] != -1:
            continue  # Child contour (hole); handled with its parent.
        if cv2.contourArea(cnt) < 80:
            continue
        outer = clean_contour(cnt, want_ccw=True)
        if outer is None:
            continue

        loops = [outer]
        child = hier[i][2]
        while child != -1:
            if cv2.contourArea(contours[child]) >= 40:
                hole = clean_contour(contours[child], want_ccw=False)
                if hole is not None:
                    loops.append(hole)
            child = hier[child][0]

        # Build safe per-loop inset points for the front/back bevel lips.
        inset_loops: list[np.ndarray] = []
        out_normals: list[np.ndarray] = []
        for lp in loops:
            n2 = _loop_outward_normals_2d(lp)
            hw = sample_half_w_mm(lp)
            inset = np.minimum(bevel_in_max, np.maximum(0.04, hw * 0.22))
            inset_loops.append(lp - n2 * inset[:, None])
            out_normals.append(n2)

        # Triangulate the inset polygon-with-holes (fallback to outer loops if inset degenerates).
        cap_loops = inset_loops
        verts_2d = np.vstack(cap_loops).astype(np.float32)
        ring_ends = np.cumsum([len(lp) for lp in cap_loops], dtype=np.uint32)
        tris = earcut.triangulate_float32(verts_2d, ring_ends)
        if len(tris) < 3:
            cap_loops = loops
            verts_2d = np.vstack(cap_loops).astype(np.float32)
            ring_ends = np.cumsum([len(lp) for lp in cap_loops], dtype=np.uint32)
            tris = earcut.triangulate_float32(verts_2d, ring_ends)
            if len(tris) < 3:
                continue

        # Ensure front cap triangles are CCW in 2D (+Z normal).
        t3 = tris.reshape(-1, 3)
        p0 = verts_2d[t3[:, 0]]
        p1 = verts_2d[t3[:, 1]]
        p2 = verts_2d[t3[:, 2]]
        cross = (p1[:, 0] - p0[:, 0]) * (p2[:, 1] - p0[:, 1]) - (p1[:, 1] - p0[:, 1]) * (p2[:, 0] - p0[:, 0])
        flip = cross < 0
        if np.any(flip):
            t3[flip] = t3[flip][:, [0, 2, 1]]

        # 1. Front cap (exact photo texture, full brightness).
        z_front = _z_wrap(verts_2d[:, 0], half_w, bend_mm)
        pos_f = np.stack([verts_2d[:, 0], verts_2d[:, 1], z_front], axis=1)
        nrm_f = _front_normal(verts_2d[:, 0], half_w, bend_mm, sign=1.0)
        uv_f = mm_to_uv(verts_2d)
        push(pos_f, nrm_f, uv_f, 1.0, t3.ravel())

        # 2. Back cap (slightly recessed & subtly shaded for natural depth).
        pos_b = np.stack([verts_2d[:, 0], verts_2d[:, 1], z_front - thick_mm], axis=1)
        nrm_b = _front_normal(verts_2d[:, 0], half_w, bend_mm, sign=-1.0)
        push(pos_b, nrm_b, uv_f, 0.84, t3[:, [0, 2, 1]].ravel())

        # 3. Front bevel + side wall + back bevel along each boundary loop.
        for lp, lp_in, n2 in zip(loops, cap_loops, out_normals):
            m = len(lp)
            z_in = _z_wrap(lp_in[:, 0], half_w, bend_mm)
            z_out = _z_wrap(lp[:, 0], half_w, bend_mm)
            uv_in = mm_to_uv(lp_in)
            uv_out = mm_to_uv(lp)

            r0 = np.stack([lp_in[:, 0], lp_in[:, 1], z_in], axis=1)
            r1 = np.stack([lp[:, 0], lp[:, 1], z_out - bevel_z], axis=1)
            r2 = np.stack([lp[:, 0], lp[:, 1], z_out - thick_mm + bevel_z], axis=1)
            r3 = np.stack([lp_in[:, 0], lp_in[:, 1], z_in - thick_mm], axis=1)

            n_wall = np.stack([n2[:, 0], n2[:, 1], np.zeros(m)], axis=1)
            n_fbev = np.stack([n2[:, 0] * 0.72, n2[:, 1] * 0.72, np.full(m, 0.69)], axis=1)
            n_fbev /= np.maximum(np.linalg.norm(n_fbev, axis=1, keepdims=True), 1e-6)
            n_bbev = np.stack([n2[:, 0] * 0.72, n2[:, 1] * 0.72, np.full(m, -0.69)], axis=1)
            n_bbev /= np.maximum(np.linalg.norm(n_bbev, axis=1, keepdims=True), 1e-6)

            idx_i = np.arange(m, dtype=np.uint32)
            idx_n = (idx_i + 1) % m
            quads = np.stack(
                [idx_i, idx_i + m, idx_n + m, idx_i, idx_n + m, idx_n],
                axis=1,
            ).ravel()

            # Front bevel strip
            push(np.vstack([r0, r1]), np.vstack([n_fbev, n_fbev]), np.vstack([uv_in, uv_out]), 0.96, quads)
            # Side wall strip
            push(np.vstack([r1, r2]), np.vstack([n_wall, n_wall]), np.vstack([uv_out, uv_out]), 0.90, quads)
            # Back bevel strip
            push(np.vstack([r2, r3]), np.vstack([n_bbev, n_bbev]), np.vstack([uv_out, uv_in]), 0.85, quads)

    if not all_pos:
        return None
    return {
        "pos": np.vstack(all_pos) * MM_TO_M,
        "nrm": np.vstack(all_nrm),
        "uv": np.vstack(all_uv),
        "col": np.vstack(all_col),
        "idx": np.concatenate(all_idx),
    }


def _build_lens_mesh(
    lens_mask: np.ndarray,
    w_mm: float,
    h_mm: float,
    bridge_xy: tuple[float, float],
    bend_mm: float,
    thick_mm: float,
) -> dict | None:
    """Build a smooth curved 3D glass lens tucked slightly inside the front rim."""
    h, w = lens_mask.shape
    half_w = w_mm * 0.5
    bx_mm = (bridge_xy[0] - 0.5) * w_mm
    by_mm = (0.5 - bridge_xy[1]) * h_mm

    # Tuck lens perimeter slightly into the 3D rim so there is zero hairline gap.
    pad_px = max(2, round(w * 0.0045))
    k = pad_px * 2 + 1
    grown = cv2.dilate(lens_mask.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    contours, _ = cv2.findContours(grown, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    cnt = max(contours, key=cv2.contourArea)
    perim = cv2.arcLength(cnt, True)
    approx = cv2.approxPolyDP(cnt, max(1.0, 0.0045 * perim), True).reshape(-1, 2).astype(np.float64)
    if len(approx) < 6:
        return None

    u = approx[:, 0] / max(w - 1, 1)
    v = approx[:, 1] / max(h - 1, 1)
    boundary = np.stack([(u - 0.5) * w_mm - bx_mm, (0.5 - v) * h_mm - by_mm], axis=1)
    boundary = _smooth_loop(boundary, weight=0.22, passes=2)
    boundary = _dedup_loop(boundary, tol=0.25)
    if len(boundary) < 6:
        return None

    # Interior grid points give smooth spherical curvature across the lens face.
    x0, y0 = boundary.min(axis=0)
    x1, y1 = boundary.max(axis=0)
    cx, cy = (x0 + x1) * 0.5, (y0 + y1) * 0.5
    rx = max(6.0, (x1 - x0) * 0.5)
    ry = max(6.0, (y1 - y0) * 0.5)
    poly_f32 = boundary.astype(np.float32).reshape(-1, 1, 2)
    inner_pts: list[list[float]] = []
    for gx in np.linspace(x0 + 2.5, x1 - 2.5, 7):
        for gy in np.linspace(y0 + 2.5, y1 - 2.5, 6):
            if cv2.pointPolygonTest(poly_f32, (float(gx), float(gy)), True) > 2.0:
                inner_pts.append([float(gx), float(gy)])

    pts_2d = np.vstack([boundary, np.asarray(inner_pts, dtype=np.float64)]) if inner_pts else boundary
    try:
        tri = Delaunay(pts_2d)
    except Exception:  # noqa: BLE001
        return None
    simplices = tri.simplices
    centroids = pts_2d[simplices].mean(axis=1)
    inside = np.array([cv2.pointPolygonTest(poly_f32, (float(c[0]), float(c[1])), False) >= 0 for c in centroids])
    tris = simplices[inside]
    if len(tris) < 2:
        return None

    # Enforce CCW winding (+Z front face).
    p0 = pts_2d[tris[:, 0]]
    p1 = pts_2d[tris[:, 1]]
    p2 = pts_2d[tris[:, 2]]
    cross = (p1[:, 0] - p0[:, 0]) * (p2[:, 1] - p0[:, 1]) - (p1[:, 1] - p0[:, 1]) * (p2[:, 0] - p0[:, 0])
    flip = cross < 0
    if np.any(flip):
        tris = tris.copy()
        tris[flip] = tris[flip][:, [0, 2, 1]]

    # Subtle optical base-4 spherical dome + frame wrap curve, seated inside the rim groove.
    dome_mm = 1.15
    dx = (pts_2d[:, 0] - cx) / rx
    dy = (pts_2d[:, 1] - cy) / ry
    r2 = np.clip(dx * dx + dy * dy, 0.0, 1.0)
    z = _z_wrap(pts_2d[:, 0], half_w, bend_mm) - thick_mm * 0.42 + dome_mm * (1.0 - r2)

    dz_x = _dz_dx(pts_2d[:, 0], half_w, bend_mm) - 2.0 * dome_mm * dx / rx
    dz_y = -2.0 * dome_mm * dy / ry
    nrm = np.stack([-dz_x, -dz_y, np.ones_like(dz_x)], axis=1)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-6)

    pos = np.stack([pts_2d[:, 0], pts_2d[:, 1], z], axis=1) * MM_TO_M
    return {"pos": pos.astype(np.float32), "nrm": nrm.astype(np.float32), "idx": tris.astype(np.uint32).ravel()}


def _ellipsoid_mesh(
    center_mm: tuple[float, float, float],
    radii_mm: tuple[float, float, float],
    rot_y: float = 0.0,
    rot_z: float = 0.0,
    segs_u: int = 12,
    segs_v: int = 8,
) -> dict:
    cx, cy, cz = center_mm
    rx, ry, rz = radii_mm
    cy_r, sy_r = math.cos(rot_y), math.sin(rot_y)
    cz_r, sz_r = math.cos(rot_z), math.sin(rot_z)

    pos = []
    nrm = []
    for iv in range(segs_v + 1):
        phi = math.pi * iv / segs_v
        sp, cp = math.sin(phi), math.cos(phi)
        for iu in range(segs_u + 1):
            theta = 2.0 * math.pi * iu / segs_u
            st, ct = math.sin(theta), math.cos(theta)
            lx, ly, lz = rx * sp * ct, ry * cp, rz * sp * st
            nx, ny, nz = sp * ct / rx, cp / ry, sp * st / rz
            # Rotate Z then Y
            x1, y1, z1 = lx * cz_r - ly * sz_r, lx * sz_r + ly * cz_r, lz
            x2, y2, z2 = x1 * cy_r + z1 * sy_r, y1, -x1 * sy_r + z1 * cy_r
            nx1, ny1, nz1 = nx * cz_r - ny * sz_r, nx * sz_r + ny * cz_r, nz
            nx2, ny2, nz2 = nx1 * cy_r + nz1 * sy_r, ny1, -nx1 * sy_r + nz1 * cy_r
            nl = max(1e-6, math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2))
            pos.append([(cx + x2) * MM_TO_M, (cy + y2) * MM_TO_M, (cz + z2) * MM_TO_M])
            nrm.append([nx2 / nl, ny2 / nl, nz2 / nl])

    idx = []
    stride = segs_u + 1
    for iv in range(segs_v):
        for iu in range(segs_u):
            a = iv * stride + iu
            b = a + 1
            c = a + stride
            d = c + 1
            idx.extend([a, b, d, a, d, c])
    return {
        "pos": np.asarray(pos, dtype=np.float32),
        "nrm": np.asarray(nrm, dtype=np.float32),
        "idx": np.asarray(idx, dtype=np.uint32),
    }


def _tube_mesh(points_mm: np.ndarray, radius_mm: float, sides: int = 8) -> dict:
    """Extrude a smooth circular tube along a 3D polyline."""
    pts = np.asarray(points_mm, dtype=np.float64)
    n = len(pts)
    pos = []
    nrm = []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        t /= max(float(np.linalg.norm(t)), 1e-6)
        ref = np.array([0.0, 1.0, 0.0]) if abs(t[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
        u = np.cross(ref, t)
        u /= max(float(np.linalg.norm(u)), 1e-6)
        v = np.cross(t, u)
        for s in range(sides):
            ang = 2.0 * math.pi * s / sides
            d = math.cos(ang) * u + math.sin(ang) * v
            p = pts[i] + d * radius_mm
            pos.append(p * MM_TO_M)
            nrm.append(d)
    idx = []
    for i in range(n - 1):
        r0 = i * sides
        r1 = (i + 1) * sides
        for s in range(sides):
            sn = (s + 1) % sides
            idx.extend([r0 + s, r0 + sn, r1 + sn, r0 + s, r1 + sn, r1 + s])
    return {
        "pos": np.asarray(pos, dtype=np.float32),
        "nrm": np.asarray(nrm, dtype=np.float32),
        "idx": np.asarray(idx, dtype=np.uint32),
    }


def _merge_meshes(meshes: list[dict]) -> dict | None:
    meshes = [m for m in meshes if m is not None and len(m["pos"]) and len(m["idx"])]
    if not meshes:
        return None
    has_uv = all("uv" in m for m in meshes)
    has_col = all("col" in m for m in meshes)
    pos_l, nrm_l, uv_l, col_l, idx_l = [], [], [], [], []
    off = 0
    for m in meshes:
        pos_l.append(m["pos"])
        nrm_l.append(m["nrm"])
        if has_uv:
            uv_l.append(m["uv"])
        if has_col:
            col_l.append(m["col"])
        idx_l.append(m["idx"].astype(np.uint32) + off)
        off += len(m["pos"])
    out = {"pos": np.vstack(pos_l), "nrm": np.vstack(nrm_l), "idx": np.concatenate(idx_l)}
    if has_uv:
        out["uv"] = np.vstack(uv_l)
    if has_col:
        out["col"] = np.vstack(col_l)
    return out


def _build_nose_pads(
    lenses: list[dict],
    w_mm: float,
    h_mm: float,
    bridge_xy: tuple[float, float],
    bend_mm: float,
    thick_mm: float,
) -> tuple[dict | None, dict | None]:
    """Subtle translucent silicone nose pads + delicate metallic pad arms."""
    if len(lenses) != 2:
        return None, None
    half_w = w_mm * 0.5
    bx_mm = (bridge_xy[0] - 0.5) * w_mm
    left_inner_x = (lenses[0]["box"][0] + lenses[0]["box"][2] - 0.5) * w_mm - bx_mm
    right_inner_x = (lenses[1]["box"][0] - 0.5) * w_mm - bx_mm
    gap = right_inner_x - left_inner_x
    if gap < 10.0 or gap > 34.0:
        return None, None

    pad_x = float(np.clip(gap * 0.44, 6.2, 8.8))
    rim_x = float(np.clip(gap * 0.52, pad_x + 0.8, 12.0))
    pads = []
    wires = []
    for side in (-1.0, 1.0):
        px = side * pad_x
        py = -7.2
        pz = _z_wrap(px, half_w, bend_mm) - thick_mm - 3.6
        pads.append(
            _ellipsoid_mesh(
                (px, py, pz),
                (1.15, 4.2, 2.3),
                rot_y=side * 0.42,
                rot_z=side * 0.16,
            )
        )
        rx = side * rim_x
        rz = _z_wrap(rx, half_w, bend_mm) - thick_mm * 0.65
        arm_pts = np.array(
            [
                [rx, -4.0, rz],
                [side * (rim_x - 0.4), -5.6, rz - 2.1],
                [px, py + 0.6, pz + 0.6],
            ],
            dtype=np.float64,
        )
        wires.append(_tube_mesh(arm_pts, radius_mm=0.42, sides=6))
    return _merge_meshes(pads), _merge_meshes(wires)


def _build_temple_mesh(
    length_mm: float,
    h0_mm: float,
    h1_mm: float,
    thick_mm: float,
    side: float,
    metal: bool,
    textured: bool = False,
) -> tuple[dict, dict]:
    """Build a strictly symmetric ergonomic beveled 3D temple + metallic hinge joint.

    Runs in pivot-local coordinates from (0, 0, 0) backward into -Z.
    `side` = +1 for wearer-left (+X), -1 for wearer-right (-X).
    """
    straight = length_mm * 0.72
    bend_len = length_mm - straight
    n_s = 12
    n_b = 14
    drop_mm = min(15.5, max(11.5, bend_len * 0.36))
    inward_mm = 4.6 if metal else 5.2

    # Build ergonomic 3D spine: straight section with gentle 1.5° tilt -> smooth behind-ear hook.
    spine: list[np.ndarray] = []
    heights: list[float] = []
    widths: list[float] = []
    u_coords: list[float] = []

    for i in range(n_s + 1):
        t = i / n_s
        z = -straight * t
        y = -straight * t * 0.014
        # Slight organic inward tuck near the ear so temple sits cleanly behind the ear.
        x = -side * (0.45 * (t**2))
        h_cur = h0_mm + (h1_mm - h0_mm) * t
        w_cur = thick_mm * (1.0 - 0.14 * t)
        spine.append(np.array([x, y, z], dtype=np.float64))
        heights.append(h_cur)
        widths.append(w_cur)
        u_coords.append(t)

    y_end = spine[-1][1]
    x_end = spine[-1][0]
    for i in range(1, n_b + 1):
        t = i / n_b
        ang = t * 0.78
        z = -straight - bend_len * math.sin(ang) * 0.88
        y = y_end - drop_mm * (1.0 - math.cos(ang)) / max(1e-4, 1.0 - math.cos(0.78))
        x = x_end - side * inward_mm * (t**1.6)
        # Gentle ergonomic paddle widening on acetate tips; slim on metal.
        tip_scale = 1.08 + 0.16 * math.sin(t * math.pi) if not metal else 1.0 + 0.10 * math.sin(t * math.pi)
        h_cur = h1_mm * tip_scale * (1.0 - 0.18 * (t**3))
        w_cur = thick_mm * (0.86 + 0.14 * math.sin(t * math.pi)) * (1.0 - 0.15 * (t**3))
        spine.append(np.array([x, y, z], dtype=np.float64))
        heights.append(max(1.0, h_cur))
        widths.append(max(0.7, w_cur))
        u_coords.append(1.0)

    pts = np.asarray(spine, dtype=np.float64)
    n_pts = len(pts)

    # 8-vertex chamfered/rounded rectangle cross-section in local (u_x, v_y) plane.
    # Ordered CCW when looking along -Z (towards the back), so outward normals point cleanly out!
    c = 0.68
    profile = np.array(
        [
            [1.0, c],
            [c, 1.0],
            [-c, 1.0],
            [-1.0, c],
            [-1.0, -c],
            [-c, -1.0],
            [c, -1.0],
            [1.0, -c],
        ],
        dtype=np.float64,
    )
    prof_v = np.array([0.16, 0.0, 0.0, 0.16, 0.84, 1.0, 1.0, 0.84], dtype=np.float64)
    m = len(profile)

    rings_pos = []
    rings_nrm = []
    rings_uv = []
    for i in range(n_pts):
        if i == 0:
            tan = pts[1] - pts[0]
        elif i == n_pts - 1:
            tan = pts[-1] - pts[-2]
        else:
            tan = pts[i + 1] - pts[i - 1]
        tan /= max(float(np.linalg.norm(tan)), 1e-6)
        # Keep local right-axis predominantly horizontal (+X), up-axis predominantly (+Y).
        up = np.array([0.0, 1.0, 0.0])
        right = np.cross(up, -tan)
        rl = float(np.linalg.norm(right))
        if rl < 1e-4:
            right = np.array([1.0, 0.0, 0.0])
        else:
            right /= rl
        up = np.cross(-tan, right)
        up /= max(float(np.linalg.norm(up)), 1e-6)

        hw = widths[i] * 0.5
        hh = heights[i] * 0.5
        # Offset slightly outward so the inner face meets the hinge cleanly.
        center = pts[i]
        u_val = u_coords[i]
        for k in range(m):
            px_l, py_l = profile[k]
            p = center + right * (px_l * hw) + up * (py_l * hh)
            nv = right * (px_l / max(hw, 0.3)) + up * (py_l / max(hh, 0.3))
            nv /= max(float(np.linalg.norm(nv)), 1e-6)
            rings_pos.append(p * MM_TO_M)
            rings_nrm.append(nv)
            u_tex = (1.0 - u_val) if side < 0 else u_val
            rings_uv.append([u_tex, prof_v[k]])

    idx = []
    for i in range(n_pts - 1):
        r0 = i * m
        r1 = (i + 1) * m
        for k in range(m):
            kn = (k + 1) % m
            # Verify outward winding: r0 -> r1 goes along -Z; profile is CCW in (+X, +Y).
            idx.extend([r0 + k, r0 + kn, r1 + kn, r0 + k, r1 + kn, r1 + k])

    pos_arr = np.asarray(rings_pos, dtype=np.float32)
    nrm_arr = np.asarray(rings_nrm, dtype=np.float32)
    uv_arr = np.asarray(rings_uv, dtype=np.float32)
    idx_arr = np.asarray(idx, dtype=np.uint32)

    # Add rounded front & tip end-caps so the temple is completely closed & watertight.
    caps_pos = []
    caps_nrm = []
    caps_uv = []
    caps_idx = []
    base = len(pos_arr)
    for is_tip in (False, True):
        ring_i = (n_pts - 1) if is_tip else 0
        c_pt = pts[ring_i] * MM_TO_M
        cap_n = (pts[-1] - pts[-2]) if is_tip else (pts[0] - pts[1])
        cap_n = cap_n / max(float(np.linalg.norm(cap_n)), 1e-6)
        c_idx = base
        caps_pos.append(c_pt)
        caps_nrm.append(cap_n)
        caps_uv.append([1.0 if is_tip else 0.0, 0.5])
        base += 1
        ring_start = base
        for k in range(m):
            caps_pos.append(pos_arr[ring_i * m + k])
            caps_nrm.append(cap_n)
            caps_uv.append(uv_arr[ring_i * m + k])
            base += 1
        for k in range(m):
            kn = (k + 1) % m
            if is_tip:
                caps_idx.extend([c_idx, ring_start + kn, ring_start + k])
            else:
                caps_idx.extend([c_idx, ring_start + k, ring_start + kn])

    arm_mesh = {
        "pos": np.vstack([pos_arr, np.asarray(caps_pos, dtype=np.float32)]),
        "nrm": np.vstack([nrm_arr, np.asarray(caps_nrm, dtype=np.float32)]),
        "idx": np.concatenate([idx_arr, np.asarray(caps_idx, dtype=np.uint32)]),
    }
    if textured:
        arm_mesh["uv"] = np.vstack([uv_arr, np.asarray(caps_uv, dtype=np.float32)])

    # Compact metallic hinge barrel right at the inner pivot corner (adds crisp realism on 3/4 turns).
    hinge_r = float(np.clip(thick_mm * 0.42, 0.65, 1.35))
    hinge_h = float(np.clip(h0_mm * 0.72, 1.8, 4.8))
    hinge_x = -side * (thick_mm * 0.35)
    hinge_pts = np.array(
        [
            [hinge_x, -hinge_h * 0.5, -0.6],
            [hinge_x, hinge_h * 0.5, -0.6],
        ],
        dtype=np.float64,
    )
    hinge_mesh = _tube_mesh(hinge_pts, radius_mm=hinge_r, sides=10)
    return arm_mesh, hinge_mesh


class _GlbWriter:
    """Minimal, spec-compliant glTF 2.0 binary (.glb) writer."""

    def __init__(self) -> None:
        self._bin = bytearray()
        self._buffer_views: list[dict] = []
        self._accessors: list[dict] = []
        self._images: list[dict] = []
        self._textures: list[dict] = []
        self._materials: list[dict] = []
        self._meshes: list[dict] = []
        self._nodes: list[dict] = []

    def _pad4(self) -> None:
        rem = len(self._bin) & 3
        if rem:
            self._bin.extend(b"\x00" * (4 - rem))

    def _add_view(self, data: bytes, target: int | None = None) -> int:
        self._pad4()
        offset = len(self._bin)
        self._bin.extend(data)
        bv: dict = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            bv["target"] = target
        idx = len(self._buffer_views)
        self._buffer_views.append(bv)
        return idx

    def _add_accessor(self, arr: np.ndarray, comp_type: int, acc_type: str, target: int, bounds: bool = False) -> int:
        raw = np.ascontiguousarray(arr).tobytes()
        bv = self._add_view(raw, target=target)
        acc: dict = {
            "bufferView": bv,
            "componentType": comp_type,
            "count": int(arr.shape[0]),
            "type": acc_type,
        }
        if bounds and len(arr):
            acc["min"] = [float(v) for v in arr.min(axis=0)]
            acc["max"] = [float(v) for v in arr.max(axis=0)]
        idx = len(self._accessors)
        self._accessors.append(acc)
        return idx

    def add_texture_png(self, png_bytes: bytes) -> int:
        bv = self._add_view(png_bytes)
        img_idx = len(self._images)
        self._images.append({"bufferView": bv, "mimeType": "image/png"})
        tex_idx = len(self._textures)
        self._textures.append({"source": img_idx, "sampler": 0})
        return tex_idx

    def add_material(self, mat: dict) -> int:
        idx = len(self._materials)
        self._materials.append(mat)
        return idx

    def add_mesh(self, name: str, primitives: list[tuple[dict, int]]) -> int:
        gltf_prims = []
        for geo, mat_idx in primitives:
            if geo is None or len(geo["pos"]) == 0 or len(geo["idx"]) == 0:
                continue
            attrs = {
                "POSITION": self._add_accessor(geo["pos"].astype(np.float32), 5126, "VEC3", 34962, bounds=True),
                "NORMAL": self._add_accessor(geo["nrm"].astype(np.float32), 5126, "VEC3", 34962),
            }
            if "uv" in geo:
                attrs["TEXCOORD_0"] = self._add_accessor(geo["uv"].astype(np.float32), 5126, "VEC2", 34962)
            if "col" in geo:
                attrs["COLOR_0"] = self._add_accessor(geo["col"].astype(np.float32), 5126, "VEC3", 34962)
            indices = geo["idx"].astype(np.uint32)
            if int(indices.max()) < 65535:
                idx_acc = self._add_accessor(indices.astype(np.uint16), 5123, "SCALAR", 34963)
            else:
                idx_acc = self._add_accessor(indices, 5125, "SCALAR", 34963)
            gltf_prims.append({"attributes": attrs, "indices": idx_acc, "material": mat_idx})
        mesh_idx = len(self._meshes)
        self._meshes.append({"name": name, "primitives": gltf_prims})
        return mesh_idx

    def add_node(
        self,
        name: str,
        mesh: int | None = None,
        translation: tuple[float, float, float] | None = None,
        children: list[int] | None = None,
    ) -> int:
        node: dict = {"name": name}
        if mesh is not None:
            node["mesh"] = mesh
        if translation is not None:
            node["translation"] = [float(v) for v in translation]
        if children:
            node["children"] = children
        idx = len(self._nodes)
        self._nodes.append(node)
        return idx

    def to_glb(self, root_nodes: list[int]) -> bytes:
        self._pad4()
        gltf: dict = {
            "asset": {"version": "2.0", "generator": "Eynek VTO Photo-to-3D Generator"},
            "scene": 0,
            "scenes": [{"name": "Eyewear", "nodes": root_nodes}],
            "nodes": self._nodes,
            "meshes": self._meshes,
            "materials": self._materials,
            "accessors": self._accessors,
            "bufferViews": self._buffer_views,
            "buffers": [{"byteLength": len(self._bin)}],
        }
        if self._textures:
            gltf["textures"] = self._textures
            gltf["images"] = self._images
            gltf["samplers"] = [
                {
                    "magFilter": 9729,
                    "minFilter": 9987,
                    "wrapS": 33071,
                    "wrapT": 33071,
                }
            ]
        json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        json_pad = (4 - (len(json_bytes) & 3)) & 3
        json_bytes += b" " * json_pad

        bin_bytes = bytes(self._bin)
        total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
        header = struct.pack("<III", 0x46546C67, 2, total)
        j_chunk = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
        b_chunk = struct.pack("<II", len(bin_bytes), 0x004E4942) + bin_bytes
        return header + j_chunk + b_chunk


def generate_eyewear_glb(
    px: np.ndarray,
    lens_interiors: list[np.ndarray],
    manifest: dict,
    temple_strips: dict[str, Image.Image] | None = None,
) -> bytes | None:
    """Generate a real PBR 3D .glb eyewear model directly from processed front/side photos."""
    h, w = px.shape[:2]
    w_mm = float(manifest.get("widthMm") or 138.0)
    h_mm = float(manifest.get("heightMm") or (w_mm * h / max(w, 1)))
    half_w = w_mm * 0.5
    bend_mm = w_mm * 0.055
    bridge = manifest.get("bridgeAnchor") or [0.5, 0.45]
    bridge_xy = (float(bridge[0]), float(bridge[1]))
    bx_mm = (bridge_xy[0] - 0.5) * w_mm
    by_mm = (0.5 - bridge_xy[1]) * h_mm

    # Frame silhouette mask: keep thin rims 100% continuous (erode lens holes slightly so
    # inner nasal rims near nose pads never get notched or broken).
    lens_union = np.zeros((h, w), dtype=bool)
    for interior in lens_interiors:
        if interior is not None and interior.shape == (h, w):
            eroded_lens = cv2.erode(interior.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=1) > 0
            lens_union |= eroded_lens
    frame_mask = (px[..., 3] > 125) & (~lens_union)
    # Close tiny gaps on razor-thin rims while keeping lens openings crisp.
    frame_mask = cv2.morphologyEx(frame_mask.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)) > 0
    frame_mask &= ~lens_union
    if frame_mask.sum() < 120:
        return None

    temple_base = manifest.get("temple") or {}
    temple_sides = manifest.get("templeSides") or {}
    hinge = manifest.get("hinge") or {"y": 0.32, "heightMm": 4.0}
    measured = [s for s in temple_sides.values() if isinstance(s, dict) and s.get("rimMm") is not None]

    def _avg_side(key: str, fallback: float) -> float:
        vals = [float(s[key]) for s in measured if s.get(key) is not None]
        return float(np.mean(vals)) if vals else float(fallback)

    finish = (measured[0].get("finish") if measured else None) or temple_base.get("finish") or "acetate"
    metal = finish == "metal"
    rim_hint = float(hinge.get("heightMm") or temple_base.get("rimMm") or 3.5)
    front_thick = float(np.clip(rim_hint * (0.52 if metal else 0.68), 1.5 if metal else 2.4, 2.5 if metal else 4.8))

    frame_geo = _build_front_frame_mesh(frame_mask, w_mm, h_mm, bridge_xy, bend_mm, front_thick)
    if frame_geo is None:
        return None

    writer = _GlbWriter()
    frame_png = _inpaint_frame_texture(px, frame_mask)
    frame_tex = writer.add_texture_png(frame_png)
    frame_mat = writer.add_material(
        {
            "name": "frame_material",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": frame_tex},
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "metallicFactor": 0.70 if metal else 0.05,
                "roughnessFactor": 0.25 if metal else 0.23,
            },
            "alphaMode": "OPAQUE",
            "doubleSided": False,
        }
    )

    # Metallic accent material for hinges & nose pad arms.
    frame_rgb = _hex_to_rgb01(manifest.get("frameColor", "#222222"))
    bright_frame = sum(frame_rgb) / 3.0
    metal_rgb = (0.78, 0.76, 0.72) if bright_frame < 0.28 else tuple(min(1.0, c * 1.25 + 0.15) for c in frame_rgb)
    hinge_mat = writer.add_material(
        {
            "name": "metal_hardware",
            "pbrMetallicRoughness": {
                "baseColorFactor": [*_rgb_to_linear(metal_rgb), 1.0],
                "metallicFactor": 0.88,
                "roughnessFactor": 0.22,
            },
            "alphaMode": "OPAQUE",
        }
    )

    child_nodes: list[int] = []

    frame_mesh_id = writer.add_mesh("front_frame", [(frame_geo, frame_mat)])
    child_nodes.append(writer.add_node("front_frame", mesh=frame_mesh_id))

    # Curved 3D PBR glass lenses.
    lenses_meta = manifest.get("lenses") or []
    for idx_l, (interior, lmeta) in enumerate(zip(lens_interiors, lenses_meta)):
        lens_geo = _build_lens_mesh(interior, w_mm, h_mm, bridge_xy, bend_mm, front_thick)
        if lens_geo is None:
            continue
        is_clear = bool(lmeta.get("clear", False))
        if is_clear:
            rgba = [*_rgb_to_linear((0.92, 0.96, 1.0)), 0.13]
            rough = 0.05
            met = 0.08
        else:
            tint_rgb = _hex_to_rgb01(lmeta.get("tint", "#2a3038"), (0.18, 0.20, 0.23))
            # Lift very dark tint slightly so PBR fresnel + transmission look like glass, not ink.
            lifted = tuple(min(1.0, c * 0.78 + 0.06) for c in tint_rgb)
            op = float(np.clip(lmeta.get("opacity", 0.55), 0.22, 0.68))
            rgba = [*_rgb_to_linear(lifted), op]
            rough = 0.07
            met = 0.12
        lens_mat = writer.add_material(
            {
                "name": f"lens_{idx_l}_material",
                "pbrMetallicRoughness": {
                    "baseColorFactor": rgba,
                    "metallicFactor": met,
                    "roughnessFactor": rough,
                },
                "alphaMode": "BLEND",
                "doubleSided": True,
            }
        )
        name = "lens_right" if idx_l == 0 else "lens_left"
        m_id = writer.add_mesh(name, [(lens_geo, lens_mat)])
        child_nodes.append(writer.add_node(name, mesh=m_id))

    # Subtle 3D nose pads & wire stems (especially authentic on thin optical frames).
    if rim_hint < 6.0:
        pad_geo, wire_geo = _build_nose_pads(lenses_meta, w_mm, h_mm, bridge_xy, bend_mm, front_thick)
        if pad_geo is not None:
            pad_mat = writer.add_material(
                {
                    "name": "nose_pad_silicone",
                    "pbrMetallicRoughness": {
                        "baseColorFactor": [*_rgb_to_linear((0.92, 0.91, 0.89)), 0.52],
                        "metallicFactor": 0.0,
                        "roughnessFactor": 0.36,
                    },
                    "alphaMode": "BLEND",
                    "doubleSided": False,
                }
            )
            prims = [(pad_geo, pad_mat)]
            if wire_geo is not None:
                prims.append((wire_geo, hinge_mat))
            pad_mesh_id = writer.add_mesh("nose_pads", prims)
            child_nodes.append(writer.add_node("nose_pads", mesh=pad_mesh_id))

    # Strictly symmetric 3D ergonomic temples under pivot nodes `temple_right` (-X) and `temple_left` (+X).
    sym_h0 = float(np.clip(_avg_side("rimMm", temple_base.get("rimMm", 4.0)), 1.5, 16.0))
    sym_h1 = float(np.clip(_avg_side("tipMm", sym_h0 * (0.68 if metal else 0.72)), 1.2, sym_h0 * 1.05))
    sym_thick = float(np.clip(_avg_side("thickMm", temple_base.get("thickMm", sym_h0 * (0.5 if metal else 0.42))), 0.95, 4.0))
    sym_len = float(temple_base.get("lengthMm") or _avg_side("lengthMm", 145.0))

    # Shared symmetric temple colour (or patterned strip texture if available).
    side_colors = [s["color"] for s in temple_sides.values() if isinstance(s, dict) and s.get("color")]
    temple_hex = side_colors[0] if side_colors else (temple_base.get("color") or manifest.get("frameColor") or "#222222")
    strip_img = None
    if temple_strips:
        strip_img = temple_strips.get("left") or temple_strips.get("right")

    if strip_img is not None:
        strip_tex = writer.add_texture_png(_png_bytes(strip_img.convert("RGB")))
        temple_mat = writer.add_material(
            {
                "name": "temple_material",
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": strip_tex},
                    "baseColorFactor": [0.92, 0.92, 0.92, 1.0],
                    "metallicFactor": 0.65 if metal else 0.06,
                    "roughnessFactor": 0.25 if metal else 0.28,
                },
                "alphaMode": "OPAQUE",
            }
        )
    else:
        temple_mat = writer.add_material(
            {
                "name": "temple_material",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [*_rgb_to_linear(_hex_to_rgb01(temple_hex)), 1.0],
                    "metallicFactor": 0.72 if metal else 0.06,
                    "roughnessFactor": 0.24 if metal else 0.26,
                },
                "alphaMode": "OPAQUE",
            }
        )

    hinge_y_frac = float(hinge.get("y", 0.32))
    hinge_y_mm = (0.5 - hinge_y_frac) * h_mm - by_mm
    hinge_x_mm = half_w - max(2.8, sym_thick * 1.15)
    t_hx = hinge_x_mm / max(half_w, 1.0)
    hinge_z_mm = -bend_mm * (t_hx * t_hx) - front_thick * 0.55

    for side, node_name in ((-1.0, "temple_right"), (1.0, "temple_left")):
        arm_geo, h_geo = _build_temple_mesh(
            sym_len,
            sym_h0,
            sym_h1,
            sym_thick,
            side=side,
            metal=metal,
            textured=(strip_img is not None),
        )
        m_id = writer.add_mesh(node_name, [(arm_geo, temple_mat), (h_geo, hinge_mat)])
        child_nodes.append(
            writer.add_node(
                node_name,
                mesh=m_id,
                translation=(side * hinge_x_mm * MM_TO_M, hinge_y_mm * MM_TO_M, hinge_z_mm * MM_TO_M),
            )
        )

    root_id = writer.add_node("glasses_root", children=child_nodes)
    return writer.to_glb([root_id])
