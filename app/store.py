"""Uploaded brand catalogs — Fittingbox-style: store owns SKUs, we host the VTO."""

from __future__ import annotations

import json
import re
import secrets
from io import BytesIO
from pathlib import Path

from PIL import Image

from app.frames import FRAMES_DIR

ROOT = Path(__file__).resolve().parent
STORES = ROOT / "data" / "stores"
SKU_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}$")
BRANDS_FILE = STORES / "brands.json"

DEFAULT_BRANDS: dict[str, dict] = {
    "demo": {
        "slug": "demo",
        "name": "Demo Optika",
        "tagline": "Eynəyi üzdə yoxla",
        "privacy": "Kamera yalnız brauzerdə işləyir. Video serverə göndərilmir.",
        "seed": True,
    }
}


def store_dir(slug: str) -> Path:
    path = STORES / slug
    (path / "frames").mkdir(parents=True, exist_ok=True)
    return path


def load_brands() -> dict[str, dict]:
    brands = {k: dict(v) for k, v in DEFAULT_BRANDS.items()}
    if BRANDS_FILE.exists():
        saved = json.loads(BRANDS_FILE.read_text(encoding="utf-8"))
        for slug, meta in saved.items():
            brands[slug] = {**brands.get(slug, {}), **meta}
    return brands


def create_brand(slug: str, name: str) -> dict:
    slug = slug.strip().lower()
    if not SLUG_RE.match(slug):
        raise ValueError("Slug: kiçik hərf, rəqəm, defis. Məs. baku-optik")
    brands = load_brands()
    if slug in brands:
        raise ValueError("Bu brend artıq var.")
    meta = {
        "slug": slug,
        "name": name.strip() or slug,
        "tagline": "Eynəyi üzdə yoxla",
        "privacy": "Kamera yalnız brauzerdə işləyir. Video serverə göndərilmir.",
        "seed": False,
        "embed_key": secrets.token_hex(8),
        "allowed_domains": [],
    }
    store_dir(slug)
    others = {k: v for k, v in brands.items() if k != "demo"}
    others[slug] = meta
    STORES.mkdir(parents=True, exist_ok=True)
    BRANDS_FILE.write_text(json.dumps(others, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def extra_catalog(slug: str) -> list[dict]:
    path = store_dir(slug) / "catalog.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def _write_catalog(slug: str, items: list[dict]) -> None:
    path = store_dir(slug) / "catalog.json"
    path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def save_uploaded_frame(
    slug: str,
    sku: str,
    name: str,
    brand: str,
    png_bytes: bytes,
) -> dict:
    if not SKU_RE.match(sku):
        raise ValueError("SKU yalnız hərf, rəqəm, - və _ ola bilər.")
    img = Image.open(BytesIO(png_bytes)).convert("RGBA")
    out = store_dir(slug) / "frames" / f"{sku}.png"
    img.save(out)
    existing = next((row for row in extra_catalog(slug) if row["id"] == sku), None)
    item = {
        "id": sku,
        "name": name or sku,
        "name_az": name or sku,
        "brand": brand or slug,
        "model": sku.upper(),
        "scale": float(existing["scale"]) if existing else 2.4,
        "offset_x": float(existing["offset_x"]) if existing else 0.0,
        "offset_y": float(existing["offset_y"]) if existing else -0.1,
        "lenses": ["#eef2f4", "#6b4f2a", "#2f4a3a", "#3b2d5c"],
        "custom": True,
        "image_url": f"/media/{slug}/{sku}.png",
    }
    items = [row for row in extra_catalog(slug) if row["id"] != sku]
    items.append(item)
    _write_catalog(slug, items)
    return item


def update_calibration(slug: str, sku: str, scale: float, offset_x: float, offset_y: float) -> dict:
    items = extra_catalog(slug)
    found = None
    for row in items:
        if row["id"] == sku:
            row["scale"] = max(1.4, min(3.6, float(scale)))
            row["offset_x"] = max(-0.5, min(0.5, float(offset_x)))
            row["offset_y"] = max(-0.5, min(0.5, float(offset_y)))
            found = row
            break
    if found is None:
        raise ValueError("SKU kataloqda yoxdur (yalnız yüklənmiş eynək kalibr olunur).")
    _write_catalog(slug, items)
    return found


def delete_frame(slug: str, sku: str) -> None:
    items = extra_catalog(slug)
    nxt = [row for row in items if row["id"] != sku]
    if len(nxt) == len(items):
        raise ValueError("SKU tapılmadı.")
    _write_catalog(slug, nxt)
    path = store_dir(slug) / "frames" / f"{sku}.png"
    if path.exists():
        path.unlink()


def update_domains(slug: str, domains: str) -> list[str]:
    """Whitelist of merchant sites allowed to iframe this brand's widget."""
    parsed = []
    for raw in re.split(r"[,\s]+", domains.strip()):
        if not raw:
            continue
        host = raw.lower().removeprefix("https://").removeprefix("http://").split("/")[0]
        if host and host not in parsed:
            parsed.append(host)
    brands = load_brands()
    if slug not in brands:
        raise ValueError("Brend tapılmadı.")
    others = {k: v for k, v in brands.items() if k != "demo"}
    if slug == "demo":
        raise ValueError("Demo brendə domen qoyulmur.")
    others[slug]["allowed_domains"] = parsed
    BRANDS_FILE.write_text(json.dumps(others, ensure_ascii=False, indent=2), encoding="utf-8")
    return parsed


STAT_EVENTS = ("open", "tryon", "click")


def bump_stat(slug: str, event: str) -> dict:
    if event not in STAT_EVENTS:
        raise ValueError("Naməlum hadisə.")
    path = store_dir(slug) / "stats.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    data[event] = int(data.get(event, 0)) + 1
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def get_stats(slug: str) -> dict:
    path = store_dir(slug) / "stats.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    return {event: int(data.get(event, 0)) for event in STAT_EVENTS}


def media_path(slug: str, filename: str) -> Path | None:
    if "/" in filename or "\\" in filename or not filename.endswith(".png"):
        return None
    path = store_dir(slug) / "frames" / filename
    if not path.exists():
        builtin = FRAMES_DIR / filename
        return builtin if builtin.exists() else None
    return path
