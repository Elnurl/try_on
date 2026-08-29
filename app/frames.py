"""Generate simple transparent frame PNGs so the demo runs without product photos."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

FRAMES_DIR = Path(__file__).resolve().parent / "data" / "frames"


def _blank(size: int = 900) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (size, int(size * 0.38)), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def _lens(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    rim: tuple[int, int, int, int],
    width: int,
) -> None:
    draw.ellipse(box, outline=rim, width=width)
    inner = (box[0] + width, box[1] + width, box[2] - width, box[3] - width)
    draw.ellipse(inner, fill=(180, 200, 220, 28))


def round_black() -> Image.Image:
    img, draw = _blank()
    rim = (18, 18, 18, 255)
    _lens(draw, (70, 40, 380, 300), rim, 22)
    _lens(draw, (520, 40, 830, 300), rim, 22)
    draw.rounded_rectangle((380, 150, 520, 175), radius=6, fill=rim)
    draw.arc((20, 120, 90, 220), 90, 270, fill=rim, width=10)
    draw.arc((810, 120, 880, 220), 270, 90, fill=rim, width=10)
    return img


def square_tortoise() -> Image.Image:
    img, draw = _blank()
    rim = (92, 52, 28, 255)
    for box in ((60, 50, 400, 290), (500, 50, 840, 290)):
        draw.rounded_rectangle(box, radius=28, fill=(40, 24, 12, 50), outline=rim, width=24)
    draw.rectangle((400, 145, 500, 175), fill=rim)
    return img


def aviator_gold() -> Image.Image:
    img, draw = _blank()
    rim = (196, 154, 58, 255)
    _lens(draw, (80, 70, 400, 310), rim, 10)
    _lens(draw, (500, 70, 820, 310), rim, 10)
    draw.line((400, 120, 500, 120), fill=rim, width=8)
    draw.polygon([(430, 120), (450, 40), (470, 120)], fill=rim)
    return img


def cat_eye() -> Image.Image:
    img, draw = _blank()
    rim = (28, 28, 32, 255)
    for pts in (
        [(90, 160), (70, 70), (390, 50), (410, 250), (120, 270)],
        [(810, 160), (830, 70), (510, 50), (490, 250), (780, 270)],
    ):
        draw.polygon(pts, fill=(20, 20, 24, 50), outline=rim)
    draw.line((410, 140, 490, 140), fill=rim, width=10)
    return img


def slim_metal() -> Image.Image:
    img, draw = _blank()
    rim = (160, 160, 168, 255)
    _lens(draw, (90, 80, 390, 270), rim, 8)
    _lens(draw, (510, 80, 810, 270), rim, 8)
    draw.line((390, 165, 510, 165), fill=rim, width=5)
    return img


GENERATORS = {
    "round-black": round_black,
    "square-tortoise": square_tortoise,
    "aviator-gold": aviator_gold,
    "cat-eye": cat_eye,
    "slim-metal": slim_metal,
}


ASSET_VERSION = "2"


def ensure_frame_assets() -> None:
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    marker = FRAMES_DIR / f".v{ASSET_VERSION}"
    if marker.exists() and all((FRAMES_DIR / f"{sku}.png").exists() for sku in GENERATORS):
        return
    for sku, fn in GENERATORS.items():
        fn().save(FRAMES_DIR / f"{sku}.png")
    marker.write_text(ASSET_VERSION, encoding="utf-8")
