"""Frame catalog and per-SKU overlay calibration.

scale: frame width as a multiple of the outer-eye distance.
offset_y: vertical shift as a fraction of eye distance (negative = up toward forehead).
offset_x: horizontal shift as a fraction of eye distance.
"""

from __future__ import annotations

from pathlib import Path

from app.frames import FRAMES_DIR, ensure_frame_assets

CATALOG: list[dict] = [
    {
        "id": "round-black",
        "name": "Round Black",
        "name_az": "Dəyirmi qara",
        "brand": "Demo Optika",
        "model": "RB-01",
        "scale": 2.35,
        "offset_x": 0.0,
        "offset_y": -0.12,
        "lenses": ["#eef2f4", "#5c4033", "#1f4d3a", "#3b2d5c"],
    },
    {
        "id": "square-tortoise",
        "name": "Square Tortoise",
        "name_az": "Kvadrat tısbağa",
        "brand": "Demo Optika",
        "model": "ST-12",
        "scale": 2.45,
        "offset_x": 0.0,
        "offset_y": -0.08,
        "lenses": ["#eef2f4", "#8a5a2b", "#2c2c2c"],
    },
    {
        "id": "aviator-gold",
        "name": "Aviator Gold",
        "name_az": "Aviator qızılı",
        "brand": "Demo Optika",
        "model": "AV-3025",
        "scale": 2.55,
        "offset_x": 0.0,
        "offset_y": 0.02,
        "lenses": ["#8eb8c8", "#6b4f2a", "#2f4a3a", "#1c1916"],
    },
    {
        "id": "cat-eye",
        "name": "Cat Eye",
        "name_az": "Pişik gözü",
        "brand": "Demo Optika",
        "model": "CE-08",
        "scale": 2.5,
        "offset_x": 0.0,
        "offset_y": -0.18,
        "lenses": ["#eef2f4", "#c45c7a", "#2f4a3a"],
    },
    {
        "id": "slim-metal",
        "name": "Slim Metal",
        "name_az": "Nazik metal",
        "brand": "Demo Optika",
        "model": "SM-7",
        "scale": 2.3,
        "offset_x": 0.0,
        "offset_y": -0.05,
        "lenses": ["#eef2f4", "#9aa3ad", "#2f4a3a"],
    },
]


def get_catalog() -> list[dict]:
    ensure_frame_assets()
    return CATALOG


def get_frame(sku: str) -> dict | None:
    return next((item for item in CATALOG if item["id"] == sku), None)


def frame_png_path(sku: str) -> Path:
    ensure_frame_assets()
    return FRAMES_DIR / f"{sku}.png"
