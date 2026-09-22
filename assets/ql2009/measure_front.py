"""Measure QL2009 C1 front photo and extract a simplified right-eye silhouette."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

FRONT = Path(__file__).with_name("2009 C1 (2).png")
OUT_DIR = Path(__file__).parent


def main() -> None:
    img = Image.open(FRONT).convert("RGB")
    arr = np.asarray(img)
    h, w = arr.shape[:2]
    print(f"image {w}x{h}")

    # White studio background; frame is near-black.
    lum = arr.mean(axis=2)
    dark = lum < 80

    ys, xs = np.where(dark)
    print(f"dark pixels {len(xs)} bbox x={xs.min()}-{xs.max()} y={ys.min()}-{ys.max()}")
    print(f"dark bbox W={xs.max()-xs.min()} H={ys.max()-ys.min()}")

    # Split left/right by vertical midline of dark bbox.
    mid_x = (xs.min() + xs.max()) / 2
    left = xs < mid_x
    right = xs >= mid_x

    def bbox(mask):
        xx, yy = xs[mask], ys[mask]
        return int(xx.min()), int(yy.min()), int(xx.max()), int(yy.max())

    lx0, ly0, lx1, ly1 = bbox(left)
    rx0, ry0, rx1, ry1 = bbox(right)
    print(f"left dark bbox {lx0},{ly0} -> {lx1},{ly1}  W={lx1-lx0} H={ly1-ly0}")
    print(f"right dark bbox {rx0},{ry0} -> {rx1},{ry1}  W={rx1-rx0} H={ry1-ry0}")

    # Bridge gap: look at the central column band for the keyhole opening.
    cx = int(mid_x)
    band = dark[:, cx - 8 : cx + 8]
    rows = np.where(band.any(axis=1))[0]
    print(f"center dark rows {rows.min()}-{rows.max()}")

    # Inner lens holes: bright region inside each rim.
    # Restrict to each eye bbox expanded a little.
    def inner_hole(x0, y0, x1, y1, name):
        pad = 8
        x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
        x1, y1 = min(w - 1, x1 + pad), min(h - 1, y1 + pad)
        crop = lum[y0 : y1 + 1, x0 : x1 + 1]
        # lens is bright (white/clear) surrounded by dark rim
        bright = crop > 170
        # ignore background outside the rim by requiring a dark ring
        # take largest bright component that is not touching crop border much
        from collections import deque

        vis = np.zeros(bright.shape, dtype=bool)
        h2, w2 = bright.shape
        best = None
        for y in range(h2):
            for x in range(w2):
                if not bright[y, x] or vis[y, x]:
                    continue
                q = deque([(y, x)])
                vis[y, x] = True
                pts = [(y, x)]
                border = False
                while q:
                    cy, cx_ = q.popleft()
                    if cy == 0 or cx_ == 0 or cy == h2 - 1 or cx_ == w2 - 1:
                        border = True
                    for ny, nx in ((cy - 1, cx_), (cy + 1, cx_), (cy, cx_ - 1), (cy, cx_ + 1)):
                        if 0 <= ny < h2 and 0 <= nx < w2 and bright[ny, nx] and not vis[ny, nx]:
                            vis[ny, nx] = True
                            q.append((ny, nx))
                            pts.append((ny, nx))
                if border:
                    continue
                if best is None or len(pts) > len(best):
                    best = pts
        if not best:
            print(f"{name}: no inner hole")
            return None
        py = np.array([p[0] for p in best])
        px = np.array([p[1] for p in best])
        print(
            f"{name} inner hole px {len(best)} "
            f"x={px.min()+x0}-{px.max()+x0} y={py.min()+y0}-{py.max()+y0} "
            f"W={px.max()-px.min()} H={py.max()-py.min()}"
        )
        return {
            "x0": int(px.min() + x0),
            "y0": int(py.min() + y0),
            "x1": int(px.max() + x0),
            "y1": int(py.max() + y0),
            "w": int(px.max() - px.min()),
            "h": int(py.max() - py.min()),
        }

    left_in = inner_hole(lx0, ly0, lx1, ly1, "left")
    right_in = inner_hole(rx0, ry0, rx1, ry1, "right")

    # Scale: A-size 49 mm = inner lens width of one eye.
    # Use average of both holes if both found.
    widths = [v["w"] for v in (left_in, right_in) if v]
    heights = [v["h"] for v in (left_in, right_in) if v]
    px_per_mm = (sum(widths) / len(widths)) / 49.0
    print(f"px_per_mm {px_per_mm:.4f}  (from inner width / 49)")
    print(f"inner height mm {np.mean(heights)/px_per_mm:.2f}")
    if left_in and right_in:
        bridge_px = right_in["x0"] - left_in["x1"]
        print(f"inner-to-inner gap (bridge-ish) {bridge_px}px = {bridge_px/px_per_mm:.2f}mm")
        print(f"outer-to-outer dark {(rx1-lx0)/px_per_mm:.2f}mm")
        print(f"left outer W {(lx1-lx0)/px_per_mm:.2f} right outer W {(rx1-rx0)/px_per_mm:.2f}")
        print(f"left outer H {(ly1-ly0)/px_per_mm:.2f} right outer H {(ry1-ry0)/px_per_mm:.2f}")

    # Sample right-eye inner and outer contours as polar points around hole center.
    def sample_contour(x0, y0, x1, y1, hole, n=64, inner=True):
        cy = (hole["y0"] + hole["y1"]) / 2
        cx = (hole["x0"] + hole["x1"]) / 2
        region = dark[y0 : y1 + 1, x0 : x1 + 1]
        pts = []
        for i in range(n):
            ang = 2 * np.pi * i / n
            # 0 = +X (outer), CCW, image Y down
            dx, dy = np.cos(ang), np.sin(ang)
            # walk from center
            r = 0.0
            last_dark = None
            first_dark = None
            for step in range(1, 800):
                px = int(round(cx + dx * step))
                py = int(round(cy + dy * step))
                if px < 0 or py < 0 or px >= w or py >= h:
                    break
                is_dark = dark[py, px]
                if first_dark is None and is_dark:
                    first_dark = step
                if first_dark is not None and last_dark and not is_dark:
                    # left the rim
                    break
                if is_dark:
                    last_dark = step
            if inner:
                r = first_dark
            else:
                r = last_dark
            if r is None:
                continue
            px = cx + dx * r
            py = cy + dy * r
            # convert to mm, origin at frame center (mid_x, average hole cy)
            pts.append((px, py, ang, r))
        return pts, cx, cy

    if not right_in:
        return

    # Use full-image dark for outer walk
    inner_pts, rcx, rcy = sample_contour(rx0, ry0, rx1, ry1, right_in, 72, True)
    outer_pts, _, _ = sample_contour(0, 0, w - 1, h - 1, right_in, 72, False)

    # Origin: midpoint between lens centers, vertical at lens center.
    if left_in:
        lcx = (left_in["x0"] + left_in["x1"]) / 2
        rcx2 = (right_in["x0"] + right_in["x1"]) / 2
        origin_x = (lcx + rcx2) / 2
        origin_y = (left_in["y0"] + left_in["y1"] + right_in["y0"] + right_in["y1"]) / 4
    else:
        origin_x = mid_x
        origin_y = rcy

    def to_mm(pts):
        out = []
        for px, py, ang, r in pts:
            # Blender: +X right, +Y up. Photo Y down.
            x_mm = (px - origin_x) / px_per_mm
            y_mm = (origin_y - py) / px_per_mm
            out.append({"x": round(x_mm, 3), "y": round(y_mm, 3), "ang": round(ang, 4)})
        return out

    data = {
        "image": str(FRONT),
        "px_per_mm": px_per_mm,
        "stamp": {"A": 49, "DBL": 18, "temple": 142},
        "inner_height_mm": float(np.mean(heights) / px_per_mm),
        "outer_width_mm": float((rx1 - lx0) / px_per_mm) if left_in else None,
        "bridge_inner_gap_mm": float((right_in["x0"] - left_in["x1"]) / px_per_mm) if left_in else None,
        "right_inner": to_mm(inner_pts),
        "right_outer": to_mm(outer_pts),
    }
    out = OUT_DIR / "front_silhouette.json"
    out.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"wrote {out} inner={len(data['right_inner'])} outer={len(data['right_outer'])}")


if __name__ == "__main__":
    main()
