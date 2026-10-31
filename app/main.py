"""Eynek VTO: photo → 2.5D virtual try-on service, SDK and seller studio."""

from __future__ import annotations

import logging
import mimetypes
import os
import re
import threading
from io import BytesIO
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from starlette.concurrency import run_in_threadpool  # noqa: E402

from app.auth import caller, require_admin  # noqa: E402
from app.pipeline import PipelineError, Sizes, build_asset, load_image, parse_sizes  # noqa: E402
from app.storage import (  # noqa: E402
    create_store,
    delete_product,
    ensure_store,
    get_product,
    get_store,
    issue_upload_token,
    list_products,
    list_stores,
    product_dir,
    rotate_key,
    save_product,
    valid_sku,
    valid_store_id,
)
from app.vendor_assets import ensure_vendor  # noqa: E402

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DEMO = ROOT / "demo"
MAX_UPLOAD = 15 * 1024 * 1024
ASSET_FILE_RE = re.compile(r"^(front|thumb)\.png$|^photo-(front|left|right)\.jpg$")

mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")

log = logging.getLogger("vto")
app = FastAPI(title="Eynek VTO", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def embed_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = "frame-ancestors *"
    response.headers["Permissions-Policy"] = "camera=*"
    return response


def _bootstrap() -> None:
    try:
        ensure_vendor()
    except Exception as exc:  # noqa: BLE001
        log.warning("Vendor bootstrap failed: %s", exc)
    try:
        seed_demo()
    except Exception as exc:  # noqa: BLE001
        log.warning("Demo seed failed: %s", exc)


def seed_demo() -> None:
    ensure_store("demo", "Demo")
    if get_product("demo", "ql2009-c1"):
        return
    front = (DEMO / "ql2009-front.png").read_bytes()
    side = (DEMO / "ql2009-side.png").read_bytes()
    asset = build_asset(load_image(front), {"left": load_image(side)}, parse_sizes("49-18-142"))
    save_product(
        "demo",
        "ql2009-c1",
        {"name": "QL2009 C1", "seller": ""},
        asset,
        {"front": _jpeg(front), "left": _jpeg(side)},
    )


def _jpeg(data: bytes) -> bytes:
    buf = BytesIO()
    load_image(data).convert("RGB").save(buf, "JPEG", quality=88)
    return buf.getvalue()


def base_url(request: Request) -> str:
    env = os.environ.get("PUBLIC_URL", "").rstrip("/")
    if env:
        return env
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


def public_manifest(m: dict, base: str) -> dict:
    root = f"{base}/assets/{m['store']}/{m['sku']}"
    v = m.get("updatedAt", 0)
    out = {k: v2 for k, v2 in m.items() if k not in ("photos", "background", "seller")}
    out["texture"] = f"{root}/front.png?v={v}"
    out["thumb"] = f"{root}/thumb.png?v={v}"
    out["photos"] = {name: f"{root}/photo-{name}.jpg?v={v}" for name in m.get("photos", [])}
    return out


def page(name: str) -> FileResponse:
    return FileResponse(STATIC / name, headers={"Cache-Control": "no-cache"})


@app.get("/", include_in_schema=False)
def home():
    return page("index.html")


@app.get("/embed", include_in_schema=False)
def embed():
    return page("embed.html")


@app.get("/studio", include_in_schema=False)
def studio():
    return page("studio.html")


@app.get("/admin", include_in_schema=False)
def admin():
    return page("admin.html")


@app.get("/sdk/eynek-vto.js", include_in_schema=False)
@app.get("/vto-widget.js", include_in_schema=False)
def sdk_script():
    return FileResponse(
        STATIC / "sdk" / "eynek-vto.js",
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=300"},
    )


@app.get("/try", include_in_schema=False)
def legacy_try():
    return RedirectResponse("/")


@app.get("/api/health")
def health():
    return {"ok": True, "service": "eynek-vto", "version": app.version}


@app.get("/assets/{store}/{sku}/{filename}", include_in_schema=False)
def asset_file(store: str, sku: str, filename: str):
    if not (valid_store_id(store) and valid_sku(sku) and ASSET_FILE_RE.match(filename)):
        raise HTTPException(status_code=404)
    path = product_dir(store, sku) / filename
    if not path.exists():
        raise HTTPException(status_code=404)
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/v1/stores/{store}/products")
def public_products(store: str, request: Request):
    if not get_store(store):
        raise HTTPException(status_code=404, detail="Mağaza tapılmadı.")
    base = base_url(request)
    return {
        "store": store,
        "products": [
            {"sku": m["sku"], "name": m.get("name", m["sku"]), "thumb": public_manifest(m, base)["thumb"]}
            for m in list_products(store)
        ],
    }


@app.get("/v1/stores/{store}/products/{sku}")
def public_product(store: str, sku: str, request: Request):
    m = get_product(store, sku) if valid_store_id(store) and valid_sku(sku) else None
    if not m:
        raise HTTPException(status_code=404, detail="Bu məhsul üçün VTO hazır deyil.")
    return JSONResponse(public_manifest(m, base_url(request)), headers={"Cache-Control": "public, max-age=60"})


Caller = Annotated[dict, Depends(caller)]


@app.get("/v1/me")
def me(who: Caller):
    return {**who, "name": (get_store(who["store"]) or {}).get("name")}


async def _read_upload(file: UploadFile | None, label: str) -> bytes | None:
    if file is None or not file.filename:
        return None
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail=f"{label} şəkli 15 MB-dan böyükdür.")
    return data or None


@app.post("/v1/products")
async def create_product(
    who: Caller,
    request: Request,
    sku: Annotated[str, Form()],
    front: Annotated[UploadFile, File()],
    name: Annotated[str, Form()] = "",
    sizes: Annotated[str, Form()] = "",
    width_mm: Annotated[float | None, Form()] = None,
    product_url: Annotated[str, Form()] = "",
    left: Annotated[UploadFile | None, File()] = None,
    right: Annotated[UploadFile | None, File()] = None,
):
    sku = sku.strip()
    if not valid_sku(sku):
        raise HTTPException(status_code=400, detail="SKU yalnız hərf, rəqəm, '.', '_' və '-' ola bilər.")
    existing = get_product(who["store"], sku)
    if existing and who["seller"] is not None and existing.get("seller") != who["seller"]:
        raise HTTPException(status_code=403, detail="Bu SKU başqa satıcıya aiddir.")
    raw = {"front": await _read_upload(front, "Ön"), "left": await _read_upload(left, "Sol"), "right": await _read_upload(right, "Sağ")}
    if not raw["front"]:
        raise HTTPException(status_code=400, detail="Ön şəkil mütləqdir.")
    parsed = parse_sizes(sizes)
    parsed = Sizes(parsed.lens_mm, parsed.bridge_mm, parsed.temple_mm, width_mm)

    def work():
        images = {k: load_image(v) for k, v in raw.items() if v}
        asset = build_asset(images.pop("front"), images, parsed)
        photos = {k: _jpeg(v) for k, v in raw.items() if v}
        meta = {"name": name.strip() or sku, "seller": who["seller"] or "", "productUrl": product_url.strip()}
        return save_product(who["store"], sku, meta, asset, photos)

    try:
        manifest = await run_in_threadpool(work)
    except PipelineError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return public_manifest(manifest, base_url(request))


@app.get("/v1/products")
def my_products(who: Caller, request: Request):
    base = base_url(request)
    items = list_products(who["store"])
    if who["seller"] is not None:
        items = [m for m in items if m.get("seller") == who["seller"]]
    return {"store": who["store"], "products": [public_manifest(m, base) for m in items]}


@app.delete("/v1/products/{sku}")
def remove_product(sku: str, who: Caller):
    existing = get_product(who["store"], sku) if valid_sku(sku) else None
    if not existing:
        raise HTTPException(status_code=404, detail="Məhsul tapılmadı.")
    if who["seller"] is not None and existing.get("seller") != who["seller"]:
        raise HTTPException(status_code=403, detail="Bu SKU başqa satıcıya aiddir.")
    delete_product(who["store"], sku)
    return {"ok": True}


class TokenRequest(BaseModel):
    seller: str = ""
    ttl: int = 3600


@app.post("/v1/upload-tokens")
def upload_token(body: TokenRequest, who: Caller, request: Request):
    if who["seller"] is not None:
        raise HTTPException(status_code=403, detail="Token yalnız mağaza API açarı ilə yaradılır.")
    ttl = max(300, min(body.ttl, 7 * 24 * 3600))
    token = issue_upload_token(who["store"], body.seller.strip()[:80], ttl)
    return {"token": token, "expiresIn": ttl, "studioUrl": f"{base_url(request)}/studio?token={token}"}


class StoreRequest(BaseModel):
    id: str
    name: str = ""


@app.get("/v1/admin/stores", dependencies=[Depends(require_admin)])
def admin_stores():
    return {"stores": list_stores()}


@app.post("/v1/admin/stores", dependencies=[Depends(require_admin)])
def admin_create_store(body: StoreRequest):
    store_id = body.id.strip().lower()
    if not valid_store_id(store_id):
        raise HTTPException(status_code=400, detail="ID: kiçik hərf, rəqəm, '-' və '_' (2-48 simvol).")
    try:
        key = create_store(store_id, body.name.strip())
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"id": store_id, "apiKey": key}


@app.post("/v1/admin/stores/{store_id}/key", dependencies=[Depends(require_admin)])
def admin_rotate_key(store_id: str):
    try:
        return {"id": store_id, "apiKey": rotate_key(store_id)}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Mağaza tapılmadı.") from exc


@app.post("/v1/admin/stores/{store_id}/upload-link", dependencies=[Depends(require_admin)])
def admin_upload_link(store_id: str, body: TokenRequest, request: Request):
    if not get_store(store_id):
        raise HTTPException(status_code=404, detail="Mağaza tapılmadı.")
    ttl = max(300, min(body.ttl, 30 * 24 * 3600))
    token = issue_upload_token(store_id, body.seller.strip()[:80], ttl)
    return {"token": token, "expiresIn": ttl, "studioUrl": f"{base_url(request)}/studio?token={token}"}


threading.Thread(target=_bootstrap, name="bootstrap", daemon=True).start()
