"""Per-brand storefronts. Instagram bio → /t/{slug}, website iframe → /embed?brand=."""

from __future__ import annotations

from app.catalog import get_catalog
from app.store import extra_catalog, load_brands


def get_brand(slug: str) -> dict | None:
    return load_brands().get(slug)


def list_brands() -> list[dict]:
    return list(load_brands().values())


def _with_image(slug: str, item: dict) -> dict:
    if item.get("custom"):
        return {**item, "image_url": f"/media/{slug}/{item['id']}.png"}
    return {**item, "image_url": f"/frames/{item['id']}.png"}


def brand_payload(slug: str) -> dict | None:
    brand = get_brand(slug)
    if brand is None:
        return None
    by_id: dict[str, dict] = {}
    if brand.get("seed"):
        for item in get_catalog():
            by_id[item["id"]] = _with_image(slug, item)
    for item in extra_catalog(slug):
        by_id[item["id"]] = _with_image(slug, item)
    return {**brand, "frames": list(by_id.values())}
