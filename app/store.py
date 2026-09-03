"""Uploaded brand catalogs — Fittingbox-style: store owns SKUs, we host the VTO."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from PIL import Image

from app.frames import FRAMES_DIR

ROOT = Path(__file__).resolve().parent
STORES = ROOT / "data" / "stores"
SKU_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}$")
BRANDS_FILE = STORES / "brands.json"
LEADS_FILE = STORES / "leads.json"
APPLICATIONS_FILE = STORES / "applications.json"
AZ_SLUG = str.maketrans(
    {
        "ə": "e",
        "Ə": "e",
        "ı": "i",
        "I": "i",
        "İ": "i",
        "ö": "o",
        "Ö": "o",
        "ü": "u",
        "Ü": "u",
        "ş": "s",
        "Ş": "s",
        "ç": "c",
        "Ç": "c",
        "ğ": "g",
        "Ğ": "g",
    }
)

DEFAULT_BRANDS: dict[str, dict] = {
    "demo": {
        "slug": "demo",
        "name": "Demo Optika",
        "tagline": "Eynəyi üzdə yoxla",
        "privacy": "Kamera yalnız brauzerdə işləyir. Video serverə göndərilmir.",
        "seed": True,
        "accent": "#0a6e74",
        "cart_url": "",
        "store_mode": "hosted",
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
        "accent": "#0a6e74",
        "cart_url": "",
        "store_mode": "",
    }
    store_dir(slug)
    return persist_brand(slug, meta)


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
        "angles": list(existing.get("angles", [])) if existing else [],
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


MAX_ANGLES = 6


def add_angle(slug: str, sku: str, image_bytes: bytes) -> dict:
    """Extra product photos (side/angle views) shown in the try-on rail."""
    items = extra_catalog(slug)
    item = next((row for row in items if row["id"] == sku), None)
    if item is None:
        raise ValueError("SKU tapılmadı (bucaq şəkli yalnız yüklənmiş eynəyə əlavə olunur).")
    angles = item.setdefault("angles", [])
    if len(angles) >= MAX_ANGLES:
        raise ValueError(f"Maksimum {MAX_ANGLES} əlavə şəkil olar.")
    img = Image.open(BytesIO(image_bytes)).convert("RGBA")
    n = 1
    frames = store_dir(slug) / "frames"
    while (frames / f"{sku}--a{n}.png").exists():
        n += 1
    filename = f"{sku}--a{n}.png"
    img.save(frames / filename)
    angles.append(f"/media/{slug}/{filename}")
    _write_catalog(slug, items)
    return item


def delete_frame(slug: str, sku: str) -> None:
    items = extra_catalog(slug)
    nxt = [row for row in items if row["id"] != sku]
    if len(nxt) == len(items):
        raise ValueError("SKU tapılmadı.")
    _write_catalog(slug, nxt)
    frames = store_dir(slug) / "frames"
    for path in [frames / f"{sku}.png", *frames.glob(f"{sku}--a*.png")]:
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
    if slug == "demo":
        raise ValueError("Demo brendə domen qoyulmur.")
    if slug not in load_brands():
        raise ValueError("Brend tapılmadı.")
    update_brand(slug, allowed_domains=parsed)
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


def save_brand_settings(slug: str, accent: str, cart_url: str) -> dict:
    brands = load_brands()
    if slug not in brands:
        raise ValueError("Brend tapılmadı.")
    color = (accent or "").strip() or "#0a6e74"
    if not re.match(r"^#[0-9a-fA-F]{6}$", color):
        raise ValueError("Rəng #RRGGBB formatında olmalıdır.")
    url = (cart_url or "").strip()
    if url and not url.startswith(("http://", "https://")):
        raise ValueError("Səbət linki http:// və ya https:// ilə başlamalıdır.")
    return update_brand(slug, accent=color, cart_url=url)


def persist_brand(slug: str, row: dict) -> dict:
    saved = json.loads(BRANDS_FILE.read_text(encoding="utf-8")) if BRANDS_FILE.exists() else {}
    saved[slug] = row
    STORES.mkdir(parents=True, exist_ok=True)
    BRANDS_FILE.write_text(json.dumps(saved, ensure_ascii=False, indent=2), encoding="utf-8")
    return row


def update_brand(slug: str, **fields) -> dict:
    brands = load_brands()
    if slug not in brands:
        raise ValueError("Brend tapılmadı.")
    saved = json.loads(BRANDS_FILE.read_text(encoding="utf-8")) if BRANDS_FILE.exists() else {}
    row = {**brands[slug], **saved.get(slug, {}), **fields}
    return persist_brand(slug, row)


def public_brand(row: dict) -> dict:
    return {key: value for key, value in row.items() if key != "partner_hash"}


def hash_partner_password(password: str) -> str:
    salt = secrets.token_hex(8)
    digest = hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()
    return f"{salt}${digest}"


def check_partner_password(slug: str, password: str) -> bool:
    brand = load_brands().get(slug)
    stored = (brand or {}).get("partner_hash") or ""
    if not stored or "$" not in stored:
        return False
    salt, digest = stored.split("$", 1)
    guess = hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()
    return hmac.compare_digest(guess, digest)


def suggest_slug(name: str) -> str:
    raw = (name or "").translate(AZ_SLUG).lower()
    raw = re.sub(r"[^a-z0-9]+", "-", raw).strip("-")[:28] or "magaza"
    if not SLUG_RE.match(raw):
        raw = "magaza"
    brands = load_brands()
    base = raw
    n = 2
    while raw in brands:
        raw = f"{base}-{n}"
        n += 1
    return raw


def load_applications() -> list[dict]:
    if not APPLICATIONS_FILE.exists():
        return []
    return json.loads(APPLICATIONS_FILE.read_text(encoding="utf-8"))


def save_application(
    name: str,
    store: str,
    contact: str,
    has_site: bool,
    message: str = "",
) -> dict:
    name = (name or "").strip()
    store_name = (store or "").strip()
    contact = (contact or "").strip()
    note = (message or "").strip()
    if not name or not store_name or not contact:
        raise ValueError("Ad, mağaza adı və əlaqə doldurulmalıdır.")
    if len(name) > 80 or len(store_name) > 80 or len(contact) > 80 or len(note) > 800:
        raise ValueError("Mətn çox uzundur.")
    STORES.mkdir(parents=True, exist_ok=True)
    rows = load_applications()
    row = {
        "id": secrets.token_hex(6),
        "name": name,
        "store": store_name,
        "contact": contact,
        "has_site": bool(has_site),
        "message": note,
        "status": "pending",
        "slug": "",
        "suggested_slug": suggest_slug(store_name),
        "at": datetime.now(timezone.utc).isoformat(),
    }
    rows.append(row)
    APPLICATIONS_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return row


def approve_application(app_id: str, slug: str, password: str) -> dict:
    password = (password or "").strip()
    if len(password) < 6:
        raise ValueError("Partnyor şifrəsi ən azı 6 simvol olmalıdır.")
    rows = load_applications()
    found = next((row for row in rows if row["id"] == app_id), None)
    if found is None:
        raise ValueError("Müraciət tapılmadı.")
    if found["status"] == "approved":
        raise ValueError("Bu müraciət artıq təsdiqlənib.")
    meta = create_brand(slug, found["store"])
    mode = "own_site" if found.get("has_site") else "hosted"
    update_brand(
        slug,
        partner_hash=hash_partner_password(password),
        store_mode=mode,
        contact=found["contact"],
        owner_name=found["name"],
    )
    found["status"] = "approved"
    found["slug"] = slug
    APPLICATIONS_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"slug": slug, "name": meta["name"], "password": password, "store_mode": mode}


def save_lead(name: str, store: str, contact: str, message: str = "") -> dict:
    name = (name or "").strip()
    store_name = (store or "").strip()
    contact = (contact or "").strip()
    note = (message or "").strip()
    if not name or not store_name or not contact:
        raise ValueError("Ad, mağaza və əlaqə doldurulmalıdır.")
    if len(name) > 80 or len(store_name) > 80 or len(contact) > 80 or len(note) > 800:
        raise ValueError("Mətn çox uzundur.")
    STORES.mkdir(parents=True, exist_ok=True)
    rows = json.loads(LEADS_FILE.read_text(encoding="utf-8")) if LEADS_FILE.exists() else []
    rows.append(
        {
            "name": name,
            "store": store_name,
            "contact": contact,
            "message": note,
            "at": datetime.now(timezone.utc).isoformat(),
        }
    )
    LEADS_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


def media_path(slug: str, filename: str) -> Path | None:
    if "/" in filename or "\\" in filename or not filename.endswith(".png"):
        return None
    path = store_dir(slug) / "frames" / filename
    if not path.exists():
        builtin = FRAMES_DIR / filename
        return builtin if builtin.exists() else None
    return path
