"""Per-brand storefronts. Instagram bio → /t/{slug}, website iframe → /embed?brand=."""

from __future__ import annotations

from app.catalog import get_catalog
from app.store import extra_catalog, load_brands, public_brand


def get_brand(slug: str) -> dict | None:
    return load_brands().get(slug)


def list_brands() -> list[dict]:
    out = []
    for row in load_brands().values():
        item = public_brand(row)
        item["has_partner"] = bool(row.get("partner_hash"))
        out.append(item)
    return out


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
    return {**public_brand(brand), "frames": list(by_id.values())}
