"""Glassify demo catalog + TryOnCloud server config.

The TryOnCloud key stays on the server. Never inject it into HTML or JS.
"""

from __future__ import annotations

import html
import json
import os
import re
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

from app.frames import FRAMES_DIR

ROOT = Path(__file__).resolve().parent.parent
ENV_LOCAL = ROOT / "vto-test" / ".env.local"

PRODUCTS: list[dict] = [
    {
        "id": "rb-aviator-classic",
        "name": "Aviator Classic",
        "brand": "Ray-Ban",
        "price": 259,
        "currency": "AZN",
        "frameId": "00192950009483",
        "auglio_item_id": "rb-aviator-classic",
        "auglio_category": 16,
        "garment_sku": "aviator-gold",
        "category": "Günəş eynəyi",
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
            {"name": "Qızılı / Yaşıl", "hex": "#b8960c", "frameId": "00192950009483"},
        ],
    },
    {
        "id": "rb-new-wayfarer",
        "name": "New Wayfarer",
        "brand": "Ray-Ban",
        "price": 229,
        "currency": "AZN",
        "frameId": "00889652315713",
        "auglio_item_id": "rb-new-wayfarer",
        "auglio_category": 16,
        "garment_sku": "square-tortoise",
        "category": "Günəş eynəyi",
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
            {"name": "Qara / Qara", "hex": "#1a1a1a", "frameId": "00889652315713"},
        ],
    },
]


def get_product(product_id: str) -> dict | None:
    return next((item for item in PRODUCTS if item["id"] == product_id), None)


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


def catalog_cards_html() -> str:
    cards = []
    for product in PRODUCTS:
        dots = "".join(
            (
                f'<span class="g-dot" style="background:{html.escape(color["hex"])}" '
                f'title="{html.escape(color["name"])}"></span>'
            )
            for color in product["colors"]
        )
        cards.append(
            f"""<a class="g-card" href="/product/{html.escape(product["id"])}">
              <div class="g-card-art">
                <svg viewBox="0 0 240 96" width="192" height="80" fill="none" stroke="#3f3f46" stroke-width="5" stroke-linecap="round" aria-hidden="true">
                  <rect x="12" y="22" width="84" height="52" rx="22"></rect>
                  <rect x="144" y="22" width="84" height="52" rx="22"></rect>
                  <path d="M96 46h48"></path>
                  <path d="M12 42H4"></path>
                  <path d="M228 42h8"></path>
                </svg>
                <span class="g-badge">{html.escape(product["category"])}</span>
              </div>
              <div class="g-card-body">
                <p class="g-brand">{html.escape(product["brand"])}</p>
                <h2>{html.escape(product["name"])}</h2>
                <div class="g-dots">{dots}</div>
                <div class="g-card-foot">
                  <span class="g-price">{product["price"]} {html.escape(product["currency"])}</span>
                  <span class="g-vto-chip">VTO</span>
                </div>
              </div>
            </a>"""
        )
    return "\n".join(cards)


def render_catalog(template: str) -> str:
    return template.replace("{{PRODUCT_CARDS}}", catalog_cards_html())


def render_product_page(template: str, product: dict) -> str:
    features = "".join(
        f"<li>{html.escape(item)}</li>" for item in product["features"]
    )
    return (
        template.replace(
            "{{PAGE_TITLE}}",
            html.escape(f'{product["brand"]} {product["name"]} | Glassify.az'),
        )
        .replace("{{PRODUCT_NAME}}", html.escape(product["name"]))
        .replace("{{PRODUCT_BRAND}}", html.escape(product["brand"]))
        .replace("{{PRODUCT_CATEGORY}}", html.escape(product["category"]))
        .replace("{{PRODUCT_PRICE}}", str(product["price"]))
        .replace("{{PRODUCT_CURRENCY}}", html.escape(product["currency"]))
        .replace("{{PRODUCT_DESCRIPTION}}", html.escape(product["description"]))
        .replace("{{PRODUCT_FEATURES}}", features)
        .replace("{{PRODUCT_JSON}}", json.dumps(product, ensure_ascii=False))
        .replace("{{AUGLIO_API_KEY_JSON}}", json.dumps(auglio_api_key()))
        .replace("{{AUGLIO_ITEM_ID_JSON}}", json.dumps(auglio_item_id(product)))
    )
