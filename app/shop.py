"""Eynək.com demo catalog + TryOnCloud server config.

The TryOnCloud key stays on the server. Never inject it into HTML or JS.
"""

from __future__ import annotations

import html
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse
from xml.sax.saxutils import escape as xml_escape

from app.frames import FRAMES_DIR
from app.store import marketplace_listings, marketplace_stores


ROOT = Path(__file__).resolve().parent.parent
ENV_LOCAL = ROOT / "vto-test" / ".env.local"

DEMO_STORES: list[dict] = [
    {
        "id": "nargiz-optika",
        "name": "Optika Nərgiz",
        "city": "Bakı",
        "tagline": "Ray-Ban və günəş eynəkləri",
    },
    {
        "id": "nn-optic",
        "name": "NN Optic",
        "city": "Bakı",
        "tagline": "Yerli optik çərçivələr",
    },
    {
        "id": "baku-vision",
        "name": "Baku Vision",
        "city": "Gəncə",
        "tagline": "Optik eynək və gündəlik çərçivələr",
    },
]

DEMO_PRODUCTS: list[dict] = [
    {
        "id": "rb-aviator-classic",
        "name": "Aviator Classic",
        "brand": "Ray-Ban",
        "seller_id": "nargiz-optika",
        "seller_name": "Optika Nərgiz",
        "seller_city": "Bakı",
        "price": 259,
        "currency": "AZN",
        "rating": 4.8,
        "reviews": 124,
        "tryon": True,
        "featured": True,
        "image": "/static/images/products/p4.jpg",
        "frameId": "00192950009483",
        "auglio_item_id": "rb-aviator-classic",
        "auglio_category": 16,
        "garment_sku": "aviator-gold",
        "category": "Günəş eynəyi",
        "filter": "sunglasses",
        "description": (
            "Ray-Ban Aviator Classic — 1937-ci ildən gələn ikonik dizayn. "
            "Yüksək keyfiyyətli metal çərçivə və UV qoruyucu linzalar."
        ),
        "features": [
            "UV400 qoruma",
            "Metal çərçivə",
            "Unisex dizayn",
            "Klassik pilot forması",
        ],
        "colors": [
            {"name": "Qızılı", "hex": "#b8960c", "swatch": "ink", "frameId": "00192950009483"},
            {"name": "Gümüş", "hex": "#9aa3ad", "swatch": "silver", "frameId": "00192950009483"},
            {"name": "Qara", "hex": "#1a1a1a", "swatch": "smoke", "frameId": "00192950009483"},
        ],
    },
    {
        "id": "rb-new-wayfarer",
        "name": "New Wayfarer",
        "brand": "Ray-Ban",
        "seller_id": "nargiz-optika",
        "seller_name": "Optika Nərgiz",
        "seller_city": "Bakı",
        "price": 229,
        "currency": "AZN",
        "rating": 4.9,
        "reviews": 86,
        "tryon": True,
        "featured": True,
        "image": "/static/images/products/rb-aviator-classic.jpg",
        "frameId": "00889652315713",
        "auglio_item_id": "rb-new-wayfarer",
        "auglio_category": 16,
        "garment_sku": "square-tortoise",
        "category": "Günəş eynəyi",
        "filter": "sunglasses",
        "description": (
            "Ray-Ban New Wayfarer — zamanın sınağından çıxmış ikonik forma. "
            "Yüngül plastik çərçivə, rahat taxınma."
        ),
        "features": [
            "UV400 qoruma",
            "Plastik çərçivə",
            "Unisex dizayn",
            "Klassik kvadrat forma",
        ],
        "colors": [
            {"name": "Qara", "hex": "#1a1a1a", "swatch": "ink", "frameId": "00889652315713"},
            {"name": "Tısbağa", "hex": "#6b4423", "swatch": "tortoise", "frameId": "00889652315713"},
            {"name": "Süd", "hex": "#f3efe6", "swatch": "milk", "frameId": "00889652315713"},
        ],
    },
    {
        "id": "ql2009-c1",
        "name": "QL2009 C1",
        "brand": "NN Optic",
        "seller_id": "nn-optic",
        "seller_name": "NN Optic",
        "seller_city": "Bakı",
        "price": 149,
        "currency": "AZN",
        "rating": 4.6,
        "reviews": 32,
        "tryon": True,
        "featured": True,
        "image": "/static/images/products/p5.jpg",
        "auglio_category": 15,
        "garment_sku": "ql2009-c1",
        "category": "Optik eynək",
        "filter": "optical",
        "description": (
            "NN Optic QL2009 C1 — yerli istehsal optik çərçivə. "
            "Gündəlik taxım üçün yüngül və rahat forma."
        ),
        "features": ["Yüngül çərçivə", "Unisex dizayn", "Gündəlik taxım"],
        "colors": [
            {"name": "Qara", "hex": "#1a1a1a", "swatch": "ink"},
            {"name": "Şəffaf", "hex": "#d7dde6", "swatch": "crystal"},
        ],
    },
    {
        "id": "cat-eye",
        "name": "Cat Eye",
        "brand": "Baku Vision",
        "seller_id": "baku-vision",
        "seller_name": "Baku Vision",
        "seller_city": "Gəncə",
        "price": 119,
        "currency": "AZN",
        "rating": 4.5,
        "reviews": 18,
        "tryon": False,
        "featured": False,
        "image": "/static/images/products/cat-eye.jpg",
        "garment_sku": "cat-eye",
        "category": "Optik eynək",
        "filter": "optical",
        "description": (
            "Baku Vision Cat Eye — qadınlar üçün klassik pişikgözü siluet. "
            "Yüngül plastik çərçivə, gündəlik və axşam istifadəsi üçün."
        ),
        "features": ["Pişikgözü forma", "Yüngül plastik", "Gündəlik taxım"],
        "colors": [
            {"name": "Qara", "hex": "#1a1a1a", "swatch": "ink"},
            {"name": "Bordo", "hex": "#7a2436", "swatch": "wine"},
        ],
    },
    {
        "id": "slim-metal",
        "name": "Slim Metal",
        "brand": "Baku Vision",
        "seller_id": "baku-vision",
        "seller_name": "Baku Vision",
        "seller_city": "Gəncə",
        "price": 99,
        "currency": "AZN",
        "rating": 4.4,
        "reviews": 21,
        "tryon": True,
        "featured": False,
        "image": "/static/images/products/rb-new-wayfarer.jpg",
        "garment_sku": "slim-metal",
        "category": "Optik eynək",
        "filter": "optical",
        "description": (
            "Baku Vision Slim Metal — nazik metal çərçivə. "
            "İş və gündəlik istifadə üçün yüngül optik eynək."
        ),
        "features": ["Nazik metal", "Yüngül çəki", "Unisex dizayn"],
        "colors": [
            {"name": "Gümüş", "hex": "#9aa3ad", "swatch": "silver"},
            {"name": "Qara", "hex": "#1a1a1a", "swatch": "ink"},
        ],
    },
]


def all_stores() -> list[dict]:
    by_id = {row["id"]: dict(row) for row in DEMO_STORES}
    for row in marketplace_stores():
        by_id[row["id"]] = {**by_id.get(row["id"], {}), **row}
    return list(by_id.values())


def all_products() -> list[dict]:
    by_id = {row["id"]: dict(row) for row in DEMO_PRODUCTS}
    for row in marketplace_listings():
        by_id[row["id"]] = row
    return list(by_id.values())


# Backward-compatible aliases used across the app
STORES = DEMO_STORES
PRODUCTS = DEMO_PRODUCTS


def get_product(product_id: str) -> dict | None:
    return next((item for item in all_products() if item["id"] == product_id), None)


def get_store(store_id: str) -> dict | None:
    return next((item for item in all_stores() if item["id"] == store_id), None)


def products_for_store(store_id: str) -> list[dict]:
    return [item for item in all_products() if item.get("seller_id") == store_id]


def store_with_counts() -> list[dict]:
    rows = []
    for store in all_stores():
        items = products_for_store(store["id"])
        rows.append({**store, "product_count": len(items)})
    return rows


def catalog_brands() -> list[str]:
    seen: list[str] = []
    for product in all_products():
        name = str(product.get("brand") or "").strip()
        if name and name not in seen:
            seen.append(name)
    return seen


def _read_env_local(name: str) -> str:
    if not ENV_LOCAL.is_file():
        return ""
    prefix = f"{name}="
    for line in ENV_LOCAL.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith(prefix):
            return stripped.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def fittingbox_api_key() -> str:
    for name in ("FITTINGBOX_API_KEY", "NEXT_PUBLIC_FITTINGBOX_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return _read_env_local("NEXT_PUBLIC_FITTINGBOX_API_KEY")


_AUGLIO_KEY_RE = re.compile(r"^[A-Za-z0-9._-]{8,128}$")


def auglio_api_key() -> str:
    for name in ("AUGLIO_API_KEY", "NEXT_PUBLIC_AUGLIO_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value if _AUGLIO_KEY_RE.fullmatch(value) else ""
    raw = _read_env_local("AUGLIO_API_KEY") or _read_env_local(
        "NEXT_PUBLIC_AUGLIO_API_KEY"
    )
    return raw if raw and _AUGLIO_KEY_RE.fullmatch(raw) else ""


_BANUBA_HOSTS = (
    "tintvto.com",
    "www.tintvto.com",
    "app.tintvto.com",
    "virtual-try-on-ready.banuba.com",
)


def _safe_https_url(raw: str, allowed_hosts: tuple[str, ...]) -> str:
    value = raw.strip()
    if not value:
        return ""
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host:
        return ""
    if host in allowed_hosts or host.endswith(".tintvto.com"):
        return value
    return ""


def banuba_tryon_url(product: dict) -> str:
    env_name = "BANUBA_TRYON_URL_" + str(product["id"]).upper().replace("-", "_")
    for name in (env_name, "BANUBA_TRYON_URL"):
        value = os.environ.get(name, "").strip()
        if value:
            return _safe_https_url(value, _BANUBA_HOSTS)
    from_file = _read_env_local(env_name) or _read_env_local("BANUBA_TRYON_URL")
    if from_file:
        return _safe_https_url(from_file, _BANUBA_HOSTS)
    return _safe_https_url(str(product.get("banuba_url") or ""), _BANUBA_HOSTS)


def auglio_demo_url() -> str:
    default = "https://auglio.com/en/demo-store/eyewear"
    raw = (
        os.environ.get("AUGLIO_DEMO_URL", "").strip()
        or _read_env_local("AUGLIO_DEMO_URL")
        or default
    )
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and host.endswith("auglio.com"):
        return raw
    return default


def auglio_item_id(product: dict) -> str:
    return str(product.get("auglio_item_id") or product["id"])


def auglio_feed_xml(base_url: str) -> str:
    base = base_url.rstrip("/")
    blocks = []
    for product in PRODUCTS:
        item_id = xml_escape(auglio_item_id(product))
        name = product["name"].replace("]]>", "")
        desc = product["description"].replace("]]>", "")
        brand = product["brand"].replace("]]>", "")
        category = int(product.get("auglio_category") or 16)
        page = f"{base}/product/{product['id']}"
        blocks.append(
            f"""    <SHOPITEM>
        <ITEM_ID>{item_id}</ITEM_ID>
        <PRODUCTNAME><![CDATA[{name}]]></PRODUCTNAME>
        <DESCRIPTION><![CDATA[{desc}]]></DESCRIPTION>
        <PRICE>{float(product["price"]):.2f}</PRICE>
        <IMGURL>{xml_escape(page)}</IMGURL>
        <URL>{xml_escape(page)}</URL>
        <CATEGORY>{category}</CATEGORY>
        <SEX>U</SEX>
        <EAN>{xml_escape(str(product.get("frameId") or ""))}</EAN>
        <MANUFACTURER><![CDATA[{brand}]]></MANUFACTURER>
    </SHOPITEM>"""
        )
    return '<?xml version="1.0" encoding="UTF-8"?>\n<SHOP>\n' + "\n".join(blocks) + "\n</SHOP>\n"


def fittingbox_destination_url() -> str:
    for name in ("FITTINGBOX_DESTINATION_URL", "NEXT_PUBLIC_FITTINGBOX_DESTINATION_URL"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return _read_env_local("FITTINGBOX_DESTINATION_URL") or _read_env_local(
        "NEXT_PUBLIC_FITTINGBOX_DESTINATION_URL"
    )


def tryoncloud_api_key() -> str:
    for name in ("TRYONCLOUD_API_KEY", "TRYON_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return _read_env_local("TRYONCLOUD_API_KEY") or _read_env_local("TRYON_API_KEY")


def tryoncloud_configured() -> bool:
    return bool(tryoncloud_api_key())


def garment_path(product: dict) -> Path | None:
    sku = str(product.get("garment_sku") or "").strip()
    if not sku:
        return None
    path = FRAMES_DIR / f"{sku}.png"
    return path if path.is_file() else None


_GLASSES_SVG = (
    '<svg viewBox="0 0 240 96" fill="none" stroke="currentColor" stroke-width="5" '
    'stroke-linecap="round" aria-hidden="true">'
    '<rect x="12" y="22" width="84" height="52" rx="22"></rect>'
    '<rect x="144" y="22" width="84" height="52" rx="22"></rect>'
    '<path d="M96 46h48"></path><path d="M12 42H4"></path><path d="M228 42h8"></path>'
    "</svg>"
)


def product_card_html(product: dict) -> str:
    pid = html.escape(product["id"])
    filt = html.escape(str(product.get("filter") or "sunglasses"))
    seller_id = html.escape(str(product.get("seller_id") or ""))
    seller = html.escape(str(product.get("seller_name") or ""))
    search = html.escape(
        f'{product["brand"]} {product["name"]} {product["category"]} '
        f'{product.get("seller_name") or ""}'.lower()
    )
    badge = (
        '<span class="g-tryon-badge">3D SINAQ</span>'
        if product.get("tryon")
        else ""
    )
    image = str(product.get("image") or "").strip()
    media = (
        f'<img class="g-card-photo" src="{html.escape(image)}" alt="" loading="lazy" />'
        if image
        else _GLASSES_SVG
    )
    rating_val = product.get("rating")
    rating = f"{float(rating_val):.1f}" if rating_val is not None else ""
    if seller and rating:
        seller_meta = (
            f'<p class="g-seller-meta">{seller} '
            f'<span class="star">★</span> {rating}</p>'
        )
    elif seller:
        seller_meta = f'<p class="g-seller-meta">{seller}</p>'
    else:
        seller_meta = ""
    return f"""<article class="g-card" data-product-id="{pid}" data-filter="{filt}" data-seller="{seller_id}" data-search="{search}">
  <div class="g-card-art">
    <button type="button" class="g-heart" data-save="{pid}" aria-label="{html.escape(product['name'])} saxla">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      </svg>
    </button>
    {badge}
    <a href="/product/{pid}" aria-label="{html.escape(product['brand'])} {html.escape(product['name'])}">
      {media}
    </a>
  </div>
  <a class="g-card-body" href="/product/{pid}">
    <p class="g-brand">{html.escape(product["brand"])}</p>
    <h3>{html.escape(product["name"])}</h3>
    <p class="g-price">{product["price"]} {html.escape(product["currency"])}</p>
    {seller_meta}
  </a>
</article>"""


def catalog_cards_html(products: list[dict] | None = None) -> str:
    items = products if products is not None else all_products()
    return "\n".join(product_card_html(product) for product in items)


def store_cards_html() -> str:
    cards = []
    for store in store_with_counts():
        sid = html.escape(store["id"])
        count = store["product_count"]
        label = "məhsul" if count == 1 else "məhsul"
        cards.append(
            f"""<a class="g-store-card" href="/store/{sid}">
  <p class="g-brand">{html.escape(store["city"])}</p>
  <h3>{html.escape(store["name"])}</h3>
  <p>{html.escape(store["tagline"])}</p>
  <span>{count} {label}</span>
</a>"""
        )
    return "\n".join(cards)


def brand_chips_html() -> str:
    chips = []
    for name in catalog_brands():
        chips.append(f'<span class="g-brand-chip">{html.escape(name)}</span>')
    return "\n".join(chips)


def seller_filter_chips_html() -> str:
    chips = [
        '<button type="button" class="g-chip is-on" data-seller-filter="all">Bütün mağazalar</button>'
    ]
    for store in store_with_counts():
        sid = html.escape(store["id"])
        chips.append(
            f'<button type="button" class="g-chip" data-seller-filter="{sid}">'
            f'{html.escape(store["name"])}</button>'
        )
    return "\n".join(chips)


def product_swatches_html(product: dict) -> str:
    bits = []
    for index, color in enumerate(product.get("colors") or []):
        on = " is-on" if index == 0 else ""
        bits.append(
            f'<button type="button" class="g-swatch{on}" '
            f'style="background:{html.escape(color["hex"])}" '
            f'data-color="{html.escape(color["name"])}" '
            f'aria-label="{html.escape(color["name"])}"></button>'
        )
    return "".join(bits)


def render_catalog(template: str) -> str:
    products = all_products()
    stores = store_with_counts()
    return (
        template.replace("{{PRODUCT_CARDS}}", catalog_cards_html(products))
        .replace("{{STORE_CARDS}}", store_cards_html())
        .replace("{{BRAND_CHIPS}}", brand_chips_html())
        .replace("{{SELLER_FILTER_CHIPS}}", seller_filter_chips_html())
        .replace("{{PRODUCT_COUNT}}", str(len(products)))
        .replace("{{STORE_COUNT}}", str(len(stores)))
        .replace("{{BRAND_COUNT}}", str(len(catalog_brands())))
        .replace(
            "{{PRODUCTS_JSON}}",
            json.dumps(products, ensure_ascii=False),
        )
        .replace(
            "{{STORES_JSON}}",
            json.dumps(stores, ensure_ascii=False),
        )
    )


def render_store_page(template: str, store: dict) -> str:
    items = products_for_store(store["id"])
    return (
        template.replace("{{STORE_NAME}}", html.escape(store["name"]))
        .replace("{{STORE_CITY}}", html.escape(store["city"]))
        .replace("{{STORE_TAGLINE}}", html.escape(store["tagline"]))
        .replace("{{STORE_COUNT}}", str(len(items)))
        .replace("{{PRODUCT_CARDS}}", catalog_cards_html(items))
        .replace(
            "{{PRODUCTS_JSON}}",
            json.dumps(items, ensure_ascii=False),
        )
    )


def render_product_page(template: str, product: dict) -> str:
    seller_id = html.escape(str(product.get("seller_id") or ""))
    seller_name = html.escape(str(product.get("seller_name") or "Mağaza"))
    seller_city = html.escape(str(product.get("seller_city") or ""))
    tryon = bool(product.get("tryon"))
    image = str(product.get("image") or "").strip()
    product_media = (
        f'<img class="g-stage-photo" src="{html.escape(image)}" alt="" />'
        if image
        else _GLASSES_SVG
    )
    vto_status = (
        "Auglio hazırlanır…"
        if tryon
        else "Bu çərçivə üçün Virtual Try-On tezliklə açılacaq."
    )
    return (
        template.replace(
            "{{PAGE_TITLE}}",
            html.escape(f'{product["brand"]} {product["name"]} | Eynək.com'),
        )
        .replace("{{PRODUCT_MEDIA}}", product_media)
        .replace("{{PRODUCT_NAME}}", html.escape(product["name"]))
        .replace("{{PRODUCT_BRAND}}", html.escape(product["brand"]))
        .replace("{{PRODUCT_CATEGORY}}", html.escape(product["category"]))
        .replace("{{PRODUCT_PRICE}}", str(product["price"]))
        .replace("{{PRODUCT_CURRENCY}}", html.escape(product["currency"]))
        .replace("{{PRODUCT_DESCRIPTION}}", html.escape(product["description"]))
        .replace("{{PRODUCT_RATING}}", str(product.get("rating") or 4.8))
        .replace("{{PRODUCT_REVIEWS}}", str(product.get("reviews") or 0))
        .replace("{{PRODUCT_SWATCHES}}", product_swatches_html(product))
        .replace("{{SELLER_ID}}", seller_id)
        .replace("{{SELLER_NAME}}", seller_name)
        .replace("{{SELLER_CITY}}", seller_city)
        .replace("{{VTO_STATUS}}", html.escape(vto_status))
        .replace("{{TRYON_ATTR}}", "1" if tryon else "0")
        .replace("{{PRODUCT_JSON}}", json.dumps(product, ensure_ascii=False))
        .replace("{{AUGLIO_API_KEY_JSON}}", json.dumps(auglio_api_key() if tryon else ""))
        .replace("{{AUGLIO_ITEM_ID_JSON}}", json.dumps(auglio_item_id(product) if tryon else ""))
        .replace("{{AUGLIO_DEMO_URL_JSON}}", json.dumps(auglio_demo_url()))
        .replace("{{BANUBA_TRYON_URL_JSON}}", json.dumps(banuba_tryon_url(product)))
    )
