"""Glassify demo catalog + Fittingbox client config.

The Fittingbox key is a public browser key (same as NEXT_PUBLIC_ in vto-test).
Never commit the value; read it from the environment or local .env.local.
"""

from __future__ import annotations

import html
import json
import os
from pathlib import Path

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


def fittingbox_default_frame_id() -> str:
    for name in ("FITTINGBOX_FRAME_ID", "NEXT_PUBLIC_FITTINGBOX_FRAME_ID"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return _read_env_local("NEXT_PUBLIC_FITTINGBOX_FRAME_ID") or "00192950009483"


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
        .replace("{{FITTINGBOX_API_KEY_JSON}}", json.dumps(fittingbox_api_key()))
        .replace("{{FRAME_ID_JSON}}", json.dumps(product["frameId"]))
    )
