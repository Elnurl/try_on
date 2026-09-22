"""Uploaded brand catalogs — Fittingbox-style: store owns SKUs, we host the VTO."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
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
ORDERS_FILE = STORES / "orders.json"
PAYOUTS_FILE = STORES / "payouts.json"
COMMISSION_RATE = max(0.0, min(0.5, float(os.environ.get("EYNEK_COMMISSION_RATE", "0.15"))))
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
    *,
    price: float | None = None,
    category: str = "",
    filter_key: str = "optical",
    published: bool = False,
    currency: str = "AZN",
) -> dict:
    if not SKU_RE.match(sku):
        raise ValueError("SKU yalnız hərf, rəqəm, - və _ ola bilər.")
    img = Image.open(BytesIO(png_bytes)).convert("RGBA")
    out = store_dir(slug) / "frames" / f"{sku}.png"
    img.save(out)
    existing = next((row for row in extra_catalog(slug) if row["id"] == sku), None)
    filt = (filter_key or "optical").strip().lower()
    if filt not in ("sunglasses", "optical", "luxury", "sports"):
        filt = "optical"
    category_map = {
        "sunglasses": "Günəş eynəyi",
        "optical": "Optik eynək",
        "luxury": "Lüks",
        "sports": "İdman",
    }
    cat = (category or "").strip() or category_map[filt]
    if price is not None:
        amount: float | None = max(0.0, float(price))
    elif existing and existing.get("price") is not None:
        amount = float(existing["price"])
    else:
        amount = None
    if published and amount is None:
        raise ValueError("Marketplace üçün qiymət lazımdır.")
    stock_val = int(existing.get("stock") or 0) if existing else 0
    # Yeni dərc: admin təsdiqi gözləyir. Yeniləmədə köhnə status qalır.
    if published:
        status = "pending" if not existing else str(existing.get("status") or "pending")
        if existing and existing.get("marketplace") and existing.get("status") == "approved":
            status = "approved"
    else:
        status = str(existing.get("status") or "draft") if existing else "draft"
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
        "price": amount,
        "currency": (currency or "AZN").strip().upper() or "AZN",
        "category": cat,
        "filter": filt,
        "marketplace": bool(published),
        "stock": stock_val if stock_val > 0 else (1 if published else 0),
        "status": status,
        "tryon": bool(existing.get("tryon")) if existing else False,
    }
    items = [row for row in extra_catalog(slug) if row["id"] != sku]
    items.append(item)
    _write_catalog(slug, items)
    return item


def set_frame_marketplace(slug: str, sku: str, published: bool, price: float | None = None) -> dict:
    items = extra_catalog(slug)
    found = None
    for row in items:
        if row["id"] == sku:
            if price is not None:
                row["price"] = max(0.0, float(price))
            if published and row.get("price") is None:
                raise ValueError("Marketplace üçün qiymət lazımdır.")
            row["marketplace"] = bool(published)
            if published and str(row.get("status") or "") != "approved":
                row["status"] = "pending"
            if not published:
                row["status"] = "draft"
            found = row
            break
    if found is None:
        raise ValueError("SKU tapılmadı.")
    _write_catalog(slug, items)
    return found


def marketplace_listings() -> list[dict]:
    """Published seller frames shaped for Eynək.com shop catalog."""
    brands = load_brands()
    rows: list[dict] = []
    for slug, brand in brands.items():
        seller_name = str(brand.get("name") or slug)
        seller_city = str(brand.get("city") or "Bakı")
        for frame in extra_catalog(slug):
            if not frame.get("custom") or not frame.get("marketplace"):
                continue
            if frame.get("price") is None:
                continue
            status = str(frame.get("status") or "approved")
            if status not in ("approved",):
                continue
            stock = int(frame.get("stock") or 0)
            if stock < 0:
                continue
            filt = str(frame.get("filter") or "optical")
            pid = f"{slug}-{frame['id']}"
            rows.append(
                {
                    "id": pid,
                    "sku": frame["id"],
                    "name": frame.get("name") or frame["id"],
                    "brand": frame.get("brand") or seller_name,
                    "seller_id": slug,
                    "seller_name": seller_name,
                    "seller_city": seller_city,
                    "price": int(round(float(frame["price"]))),
                    "currency": frame.get("currency") or "AZN",
                    "tryon": bool(frame.get("tryon")),
                    "featured": bool(frame.get("featured")),
                    "image": frame.get("image_url") or f"/media/{slug}/{frame['id']}.png",
                    "category": frame.get("category") or "Optik eynək",
                    "filter": filt,
                    "description": str(
                        frame.get("description")
                        or f"{frame.get('brand') or seller_name} — {frame.get('name') or frame['id']}."
                    ),
                    "colors": frame.get("colors")
                    or [{"name": "Standart", "hex": "#1a1a1a", "swatch": "ink"}],
                    "marketplace": True,
                    "stock": int(frame.get("stock") or 0),
                    "status": str(frame.get("status") or "approved"),
                }
            )
    return rows


def marketplace_stores() -> list[dict]:
    brands = load_brands()
    listed = {row["seller_id"] for row in marketplace_listings()}
    stores = []
    for slug in listed:
        brand = brands.get(slug) or {}
        stores.append(
            {
                "id": slug,
                "name": str(brand.get("name") or slug),
                "city": str(brand.get("city") or "Bakı"),
                "tagline": str(brand.get("tagline") or "EYNƏK marketplace mağazası"),
            }
        )
    return stores


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


def load_orders() -> list[dict]:
    if not ORDERS_FILE.exists():
        return []
    return json.loads(ORDERS_FILE.read_text(encoding="utf-8"))


def _notif_path(slug: str) -> Path:
    return store_dir(slug) / "notifications.json"


def add_seller_notification(slug: str, title: str, body: str = "", kind: str = "info") -> dict:
    path = _notif_path(slug)
    rows = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    row = {
        "id": secrets.token_hex(4),
        "title": title[:120],
        "body": body[:400],
        "kind": kind[:40],
        "read": False,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    rows.insert(0, row)
    path.write_text(json.dumps(rows[:100], ensure_ascii=False, indent=2), encoding="utf-8")
    return row


def seller_notifications(slug: str) -> list[dict]:
    path = _notif_path(slug)
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def mark_notifications_read(slug: str) -> int:
    path = _notif_path(slug)
    if not path.exists():
        return 0
    rows = json.loads(path.read_text(encoding="utf-8"))
    n = 0
    for row in rows:
        if not row.get("read"):
            row["read"] = True
            n += 1
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return n


def _attach_item_finance(item: dict) -> dict:
    sub = float(item.get("price") or 0) * int(item.get("quantity") or 0)
    commission = round(sub * COMMISSION_RATE, 2)
    item["subtotal"] = round(sub, 2)
    item["commission_rate"] = COMMISSION_RATE
    item["commission"] = commission
    item["seller_net"] = round(sub - commission, 2)
    return item


def save_order(payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    phone = str(payload.get("phone") or "").strip()
    city = str(payload.get("city") or "").strip()
    address = str(payload.get("address") or "").strip()
    note = str(payload.get("note") or "").strip()
    raw_items = payload.get("items") or []
    if not name or not phone:
        raise ValueError("Ad və telefon mütləqdir.")
    if len(name) > 80 or len(phone) > 40 or len(city) > 80 or len(address) > 200 or len(note) > 500:
        raise ValueError("Mətn çox uzundur.")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("Səbət boşdur.")
    items: list[dict] = []
    total = 0.0
    for row in raw_items[:40]:
        if not isinstance(row, dict):
            continue
        try:
            price = float(row.get("price") or 0)
            qty = int(row.get("quantity") or 1)
        except (TypeError, ValueError) as exc:
            raise ValueError("Məhsul məlumatı yanlışdır.") from exc
        qty = max(1, min(99, qty))
        price = max(0.0, min(100_000.0, price))
        item = {
            "id": str(row.get("id") or "")[:80],
            "name": str(row.get("name") or "")[:120],
            "brand": str(row.get("brand") or "")[:80],
            "price": price,
            "quantity": qty,
            "seller_id": str(row.get("seller_id") or row.get("store_id") or "")[:80],
            "currency": str(row.get("currency") or "AZN")[:8],
        }
        if not item["id"] or not item["name"]:
            continue
        _attach_item_finance(item)
        items.append(item)
        total += item["subtotal"]
    if not items:
        raise ValueError("Səbət boşdur.")
    commission_total = round(sum(float(i["commission"]) for i in items), 2)
    seller_total = round(sum(float(i["seller_net"]) for i in items), 2)
    STORES.mkdir(parents=True, exist_ok=True)
    rows = load_orders()
    order = {
        "id": secrets.token_hex(6),
        "name": name,
        "phone": phone,
        "city": city,
        "address": address,
        "note": note,
        "items": items,
        "total": round(total, 2),
        "commission_total": commission_total,
        "seller_total": seller_total,
        "currency": "AZN",
        "status": "new",
        "at": datetime.now(timezone.utc).isoformat(),
    }
    rows.append(order)
    ORDERS_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    sellers = {str(i.get("seller_id") or "") for i in items if i.get("seller_id")}
    for seller in sellers:
        add_seller_notification(
            seller,
            "Yeni sifariş",
            f"#{order['id']} — {order['total']} AZN",
            "order",
        )
    return {"ok": True, "id": order["id"], "total": order["total"]}


def update_frame_inventory(
    slug: str,
    sku: str,
    *,
    stock: int | None = None,
    status: str | None = None,
    price: float | None = None,
    marketplace: bool | None = None,
) -> dict:
    items = extra_catalog(slug)
    found = None
    for row in items:
        if row["id"] != sku:
            continue
        if stock is not None:
            row["stock"] = max(0, int(stock))
            if row["stock"] == 0 and row.get("status") == "approved":
                row["status"] = "out_of_stock"
            elif row["stock"] > 0 and row.get("status") == "out_of_stock":
                row["status"] = "approved" if row.get("marketplace") else "draft"
        if status is not None:
            allowed = {"draft", "pending", "approved", "rejected", "out_of_stock"}
            if status not in allowed:
                raise ValueError("Yanlış status.")
            row["status"] = status
        if price is not None:
            row["price"] = max(0.0, float(price))
        if marketplace is not None:
            row["marketplace"] = bool(marketplace)
            if marketplace and str(row.get("status") or "") not in ("approved", "pending"):
                row["status"] = "pending"
        found = row
        break
    if found is None:
        raise ValueError("SKU tapılmadı.")
    _write_catalog(slug, items)
    return found


def pending_marketplace_products() -> list[dict]:
    brands = load_brands()
    rows = []
    for slug, brand in brands.items():
        for frame in extra_catalog(slug):
            if not frame.get("custom"):
                continue
            if str(frame.get("status") or "") != "pending":
                continue
            rows.append(
                {
                    "seller_id": slug,
                    "seller_name": brand.get("name") or slug,
                    "sku": frame["id"],
                    "name": frame.get("name") or frame["id"],
                    "brand": frame.get("brand") or "",
                    "price": frame.get("price"),
                    "image": frame.get("image_url") or f"/media/{slug}/{frame['id']}.png",
                    "marketplace": bool(frame.get("marketplace")),
                    "stock": int(frame.get("stock") or 0),
                    "status": "pending",
                }
            )
    return rows


def set_listing_status(slug: str, sku: str, status: str) -> dict:
    row = update_frame_inventory(slug, sku, status=status)
    if status == "approved":
        add_seller_notification(slug, "Məhsul təsdiqləndi", f"{sku} marketplace-də aktivdir.", "product")
    elif status == "rejected":
        add_seller_notification(slug, "Məhsul rədd edildi", f"{sku} yenidən yoxlanmalıdır.", "product")
    return row


def seller_orders(slug: str) -> list[dict]:
    out = []
    for order in load_orders():
        lines = [i for i in (order.get("items") or []) if str(i.get("seller_id") or "") == slug]
        if not lines:
            continue
        for line in lines:
            _attach_item_finance(line)
        out.append(
            {
                **{k: order.get(k) for k in ("id", "name", "phone", "city", "address", "note", "status", "at")},
                "items": lines,
                "seller_subtotal": round(sum(float(i.get("subtotal") or 0) for i in lines), 2),
                "seller_commission": round(sum(float(i.get("commission") or 0) for i in lines), 2),
                "seller_net": round(sum(float(i.get("seller_net") or 0) for i in lines), 2),
            }
        )
    out.sort(key=lambda row: row.get("at") or "", reverse=True)
    return out


def update_seller_order_status(slug: str, order_id: str, status: str) -> dict:
    allowed = {"new", "confirmed", "preparing", "ready", "completed", "cancelled"}
    if status not in allowed:
        raise ValueError("Yanlış sifariş statusu.")
    rows = load_orders()
    found = None
    for order in rows:
        if order.get("id") != order_id:
            continue
        if not any(str(i.get("seller_id") or "") == slug for i in order.get("items") or []):
            raise ValueError("Bu sifariş sizə aid deyil.")
        # Multi-seller: track per-seller status map
        seller_status = dict(order.get("seller_status") or {})
        seller_status[slug] = status
        order["seller_status"] = seller_status
        # Overall stays new until all sellers progress — keep simple for now
        if status in ("confirmed", "preparing", "ready", "completed") and order.get("status") == "new":
            order["status"] = status if status != "ready" else "preparing"
        found = order
        break
    if found is None:
        raise ValueError("Sifariş tapılmadı.")
    ORDERS_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return next(o for o in seller_orders(slug) if o["id"] == order_id)


def load_payouts() -> list[dict]:
    if not PAYOUTS_FILE.exists():
        return []
    return json.loads(PAYOUTS_FILE.read_text(encoding="utf-8"))


def seller_finance(slug: str) -> dict:
    orders = seller_orders(slug)
    gross = round(sum(float(o.get("seller_subtotal") or 0) for o in orders), 2)
    commission = round(sum(float(o.get("seller_commission") or 0) for o in orders), 2)
    net = round(sum(float(o.get("seller_net") or 0) for o in orders), 2)
    payouts = [p for p in load_payouts() if p.get("seller_id") == slug]
    paid = round(sum(float(p.get("amount") or 0) for p in payouts if p.get("status") == "paid"), 2)
    pending_payout = round(max(0.0, net - paid), 2)
    return {
        "commission_rate": COMMISSION_RATE,
        "gross_sales": gross,
        "eynek_commission": commission,
        "seller_earnings": net,
        "paid_payouts": paid,
        "pending_payout": pending_payout,
        "payouts": payouts[:50],
        "order_count": len(orders),
    }


def seller_dashboard(slug: str) -> dict:
    brand = load_brands().get(slug) or {}
    frames = [f for f in extra_catalog(slug) if f.get("custom")]
    orders = seller_orders(slug)
    finance = seller_finance(slug)
    pending = sum(1 for f in frames if str(f.get("status") or "") == "pending")
    low_stock = sum(1 for f in frames if int(f.get("stock") or 0) <= 2)
    notifs = seller_notifications(slug)
    unread = sum(1 for n in notifs if not n.get("read"))
    return {
        "slug": slug,
        "name": brand.get("name") or slug,
        "store_mode": brand.get("store_mode") or "",
        "city": brand.get("city") or "",
        "products": len(frames),
        "pending_products": pending,
        "low_stock": low_stock,
        "orders_new": sum(1 for o in orders if (o.get("seller_status") or {}).get(slug, o.get("status")) == "new"),
        "orders_total": len(orders),
        "unread_notifications": unread,
        "finance": finance,
        "marketplace_url": f"/store/{slug}",
        "tryon_url": f"/t/{slug}",
    }


def update_seller_settings(slug: str, payload: dict) -> dict:
    brand = load_brands().get(slug)
    if brand is None:
        raise ValueError("Mağaza tapılmadı.")
    fields = {
        "name": str(payload.get("name") or brand.get("name") or "").strip()[:80],
        "tagline": str(payload.get("tagline") or brand.get("tagline") or "").strip()[:160],
        "city": str(payload.get("city") or brand.get("city") or "").strip()[:80],
        "contact": str(payload.get("contact") or brand.get("contact") or "").strip()[:80],
        "address": str(payload.get("address") or brand.get("address") or "").strip()[:200],
        "hours": str(payload.get("hours") or brand.get("hours") or "").strip()[:120],
        "instagram": str(payload.get("instagram") or brand.get("instagram") or "").strip()[:120],
        "website": str(payload.get("website") or brand.get("website") or "").strip()[:200],
        "description": str(payload.get("description") or brand.get("description") or "").strip()[:800],
    }
    if not fields["name"]:
        raise ValueError("Mağaza adı lazımdır.")
    return public_brand(update_brand(slug, **fields))


def media_path(slug: str, filename: str) -> Path | None:
    if "/" in filename or "\\" in filename or not filename.endswith(".png"):
        return None
    path = store_dir(slug) / "frames" / filename
    if not path.exists():
        builtin = FRAMES_DIR / filename
        return builtin if builtin.exists() else None
    return path
