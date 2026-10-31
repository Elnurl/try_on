"""JSON-on-disk storage for tenants (stores) and their try-on products.

data/
  secret.key                    HMAC secret for upload tokens
  stores.json                   {store_id: {name, key_hash, created}}
  products/{store}/{sku}/       manifest.json, front.png, thumb.png, photo-*.jpg
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from PIL import Image

from app.pipeline import Asset

DATA = Path(os.environ.get("VTO_DATA_DIR", Path(__file__).resolve().parent / "data"))
PRODUCTS = DATA / "products"
STORES_FILE = DATA / "stores.json"
SECRET_FILE = DATA / "secret.key"
PRODUCTS.mkdir(parents=True, exist_ok=True)

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,47}$")
SKU_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_lock = threading.Lock()


def valid_store_id(value: str) -> bool:
    return bool(ID_RE.match(value or ""))


def valid_sku(value: str) -> bool:
    return bool(SKU_RE.match(value or ""))


def _secret() -> bytes:
    env = os.environ.get("VTO_SECRET", "")
    if env:
        return env.encode()
    if not SECRET_FILE.exists():
        SECRET_FILE.write_bytes(secrets.token_bytes(32))
    return SECRET_FILE.read_bytes()


def _read_stores() -> dict:
    if not STORES_FILE.exists():
        return {}
    return json.loads(STORES_FILE.read_text(encoding="utf-8"))


def _write_stores(stores: dict) -> None:
    tmp = STORES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(stores, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STORES_FILE)


def _hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def list_stores() -> list[dict]:
    stores = _read_stores()
    return [
        {"id": sid, "name": s.get("name", sid), "created": s.get("created"), "products": len(list_products(sid))}
        for sid, s in sorted(stores.items())
    ]


def get_store(store_id: str) -> dict | None:
    store = _read_stores().get(store_id)
    return {"id": store_id, "name": store.get("name", store_id)} if store else None


def create_store(store_id: str, name: str) -> str:
    with _lock:
        stores = _read_stores()
        if store_id in stores:
            raise ValueError("Bu ID ilə mağaza artıq var.")
        key = f"ek_{store_id}_{secrets.token_urlsafe(24)}"
        stores[store_id] = {"name": name or store_id, "key_hash": _hash_key(key), "created": int(time.time())}
        _write_stores(stores)
    return key


def rotate_key(store_id: str) -> str:
    with _lock:
        stores = _read_stores()
        if store_id not in stores:
            raise KeyError(store_id)
        key = f"ek_{store_id}_{secrets.token_urlsafe(24)}"
        stores[store_id]["key_hash"] = _hash_key(key)
        _write_stores(stores)
    return key


def ensure_store(store_id: str, name: str) -> None:
    with _lock:
        stores = _read_stores()
        if store_id not in stores:
            stores[store_id] = {"name": name, "key_hash": "", "created": int(time.time())}
            _write_stores(stores)


def store_for_key(key: str) -> str | None:
    if not key:
        return None
    digest = _hash_key(key)
    for sid, store in _read_stores().items():
        if store.get("key_hash") and hmac.compare_digest(store["key_hash"], digest):
            return sid
    return None


def issue_upload_token(store_id: str, seller: str = "", ttl: int = 3600) -> str:
    payload = json.dumps({"s": store_id, "u": seller, "e": int(time.time()) + ttl}, separators=(",", ":")).encode()
    sig = hmac.new(_secret(), payload, hashlib.sha256).digest()[:18]
    return base64.urlsafe_b64encode(payload).decode().rstrip("=") + "." + base64.urlsafe_b64encode(sig).decode().rstrip("=")


def read_upload_token(token: str) -> dict | None:
    try:
        body, sig = token.split(".", 1)
        payload = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
        given = base64.urlsafe_b64decode(sig + "=" * (-len(sig) % 4))
    except Exception:  # noqa: BLE001
        return None
    if not hmac.compare_digest(hmac.new(_secret(), payload, hashlib.sha256).digest()[:18], given):
        return None
    data = json.loads(payload)
    if data.get("e", 0) < time.time() or not get_store(data.get("s", "")):
        return None
    return {"store": data["s"], "seller": data.get("u", "")}


def product_dir(store_id: str, sku: str) -> Path:
    return PRODUCTS / store_id / sku


def save_product(store_id: str, sku: str, meta: dict, asset: Asset, photos: dict[str, bytes]) -> dict:
    folder = product_dir(store_id, sku)
    tmp = folder.with_name(f".{sku}.tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    asset.front.save(tmp / "front.png", "PNG", optimize=True)
    thumb = asset.front.copy()
    thumb.thumbnail((480, 240), Image.LANCZOS)
    thumb.save(tmp / "thumb.png", "PNG", optimize=True)
    for name, data in photos.items():
        (tmp / f"photo-{name}.jpg").write_bytes(data)
    manifest = {
        "version": 2,
        "store": store_id,
        "sku": sku,
        **meta,
        **asset.manifest,
        "photos": sorted(photos),
        "updatedAt": int(time.time()),
    }
    (tmp / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    with _lock:
        shutil.rmtree(folder, ignore_errors=True)
        tmp.replace(folder)
    return manifest


def get_product(store_id: str, sku: str) -> dict | None:
    path = product_dir(store_id, sku) / "manifest.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def list_products(store_id: str) -> list[dict]:
    root = PRODUCTS / store_id
    if not root.exists():
        return []
    items = []
    for path in root.glob("*/manifest.json"):
        if path.parent.name.startswith("."):
            continue
        items.append(json.loads(path.read_text(encoding="utf-8")))
    items.sort(key=lambda m: m.get("updatedAt", 0), reverse=True)
    return items


def delete_product(store_id: str, sku: str) -> bool:
    folder = product_dir(store_id, sku)
    if not folder.exists():
        return False
    shutil.rmtree(folder)
    return True
