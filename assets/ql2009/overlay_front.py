"""Overlay the front render on the official QL2009 C1 front photo."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance

ROOT = Path(__file__).resolve().parent
PHOTO = ROOT / "2009 C1 (2).png"
RENDER = ROOT / "export" / "validate_front_frame.png"
if not RENDER.exists():
    RENDER = ROOT / "export" / "validate_front.png"
OUT = ROOT / "export" / "overlay_front.jpg"
PX_PER_MM = 25.6327
ORTHO_MM = 155.0
RENDER_W = 1600


def main() -> None:
    photo = Image.open(PHOTO).convert("RGBA")
    render = Image.open(RENDER).convert("RGBA")
    px_per_mm_render = RENDER_W / ORTHO_MM
    scale = PX_PER_MM / px_per_mm_render
    new_size = (int(render.width * scale), int(render.height * scale))
    render = render.resize(new_size, Image.Resampling.LANCZOS)

    # Tint render red so mismatch is obvious.
    r, g, b, a = render.split()
    tint = Image.merge("RGBA", (r.point(lambda v: 255), g.point(lambda v: 40), b.point(lambda v: 40), a))

    # Model origin is the measured front-photo frame center, not the image center.
    origin_px = (2003.5, 2002.0)
    canvas = photo.copy()
    x = int(origin_px[0] - tint.width / 2)
    y = int(origin_px[1] - tint.height / 2)
    canvas.alpha_composite(tint, (x, y))

    # Side-by-side: photo | overlay
    side = Image.new("RGB", (photo.width * 2, photo.height), (255, 255, 255))
    side.paste(photo.convert("RGB"), (0, 0))
    side.paste(canvas.convert("RGB"), (photo.width, 0))
    side.save(OUT, quality=92)
    print("wrote", OUT, side.size)


if __name__ == "__main__":
    main()
