"""Virtual try-on API: live web widget + photo overlay for chat channels."""

from __future__ import annotations

import mimetypes
import os
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

import qrcode
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles

from app.auth import (
    COOKIE_NAME,
    PARTNER_COOKIE,
    check_password,
    is_authed,
    partner_cookie_value,
    partner_slug,
    session_token,
)
from app.brands import brand_payload, get_brand, list_brands
from app.catalog import get_catalog, get_frame
from app.frames import FRAMES_DIR, ensure_frame_assets
from app.overlay import NoFaceError, overlay_bytes
from app.vendor_assets import ensure_vendor
from app.shop import (
    auglio_feed_xml,
    garment_path,
    get_product,
    get_store,
    render_catalog,
    render_product_page,
    render_store_page,
    tryoncloud_api_key,
    tryoncloud_configured,
)
from app.tryoncloud import TryOnCloudError, generate_tryon
from app.store import (
    add_angle,
    approve_application,
    bump_stat,
    check_partner_password,
    create_brand,
    delete_frame,
    get_stats,
    load_applications,
    media_path,
    public_brand,
    save_application,
    save_brand_settings,
    save_lead,
    save_uploaded_frame,
    set_frame_marketplace,
    update_brand,
    update_calibration,
    update_domains,
)

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".deepar")

QL2009_EXPORT = ROOT.parent / "assets" / "ql2009" / "export"
QL2009_PUBLIC = {"QL2009_C1.deepar", "QL2009_C1.glb", "QL2009_C1.fbx"}

ensure_frame_assets()
ensure_vendor()

app = FastAPI(title="tryon-wa", version="0.6.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
app.mount("/frames", StaticFiles(directory=FRAMES_DIR), name="frames")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def allow_brand_iframe(request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = "frame-ancestors *"
    response.headers["Permissions-Policy"] = "camera=*, microphone=*"
    return response


def require_admin_api(request: Request) -> None:
    if not is_authed(request):
        raise HTTPException(status_code=401, detail="Giriş tələb olunur: /admin/login")


def require_store_access(request: Request, slug: str) -> None:
    if is_authed(request) or partner_slug(request) == slug:
        return
    raise HTTPException(status_code=401, detail="Giriş tələb olunur.")


def render_tryon(slug: str, mode: str, sku: str = "") -> str:
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    html = (STATIC / "tryon.html").read_text(encoding="utf-8")
    return (
        html.replace("{{SLUG}}", slug)
        .replace("{{MODE}}", mode)
        .replace("{{SKU}}", sku or "")
    )


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    return (STATIC / "landing.html").read_text(encoding="utf-8")


@app.get("/t/{slug}", response_class=HTMLResponse)
def brand_page(slug: str) -> str:
    """Instagram bio / Taplink try-on page."""
    return render_tryon(slug, "page")


@app.get("/s/{slug}", response_class=HTMLResponse)
def storefront(slug: str) -> str:
    """Hosted catalog for brands without their own website."""
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    return (STATIC / "storefront.html").read_text(encoding="utf-8").replace("{{SLUG}}", slug)


@app.get("/embed", response_class=HTMLResponse)
def embed(request: Request, brand: str = "demo", sku: str = "") -> str:
    """Iframe engine used by the 1-line merchant widget."""
    meta = get_brand(brand)
    if meta is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    allowed = meta.get("allowed_domains") or []
    referer = request.headers.get("referer", "")
    if allowed and referer:
        host = (urlparse(referer).hostname or "").lower()
        own = (request.url.hostname or "").lower()
        if host and host != own and host not in allowed:
            raise HTTPException(
                status_code=403,
                detail=f"Bu domen üçün icazə yoxdur: {host}. Brend panelindən əlavə edin.",
            )
    return render_tryon(brand, "embed", sku)


@app.get("/vto-widget.js")
def vto_widget() -> FileResponse:
    return FileResponse(
        STATIC / "vto-widget.js",
        media_type="application/javascript; charset=utf-8",
    )


@app.get("/shop", response_class=HTMLResponse)
def glassify_shop() -> str:
    """Eynək.com catalog. Partner landing stays at /."""
    return render_catalog((STATIC / "shop.html").read_text(encoding="utf-8"))


@app.get("/shop/auglio-feed.xml")
def glassify_auglio_feed(request: Request) -> Response:
    """Public Auglio product XML. Paste this URL in Auglio → Import products."""
    base = str(request.base_url).rstrip("/")
    return Response(
        content=auglio_feed_xml(base),
        media_type="application/xml; charset=utf-8",
    )


@app.get("/shop/product/{product_id}", response_class=HTMLResponse)
def glassify_product_alias(product_id: str) -> RedirectResponse:
    return RedirectResponse(f"/product/{product_id}", status_code=307)


@app.get("/shop/cart", response_class=HTMLResponse)
def glassify_cart_alias() -> RedirectResponse:
    return RedirectResponse("/cart", status_code=307)


@app.get("/product/{product_id}", response_class=HTMLResponse)
def glassify_product(product_id: str) -> str:
    product = get_product(product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Məhsul tapılmadı.")
    return render_product_page(
        (STATIC / "shop-product.html").read_text(encoding="utf-8"),
        product,
    )


@app.get("/store/{store_id}", response_class=HTMLResponse)
def glassify_store(store_id: str) -> str:
    store = get_store(store_id)
    if store is None:
        raise HTTPException(status_code=404, detail="Mağaza tapılmadı.")
    return render_store_page(
        (STATIC / "shop-store.html").read_text(encoding="utf-8"),
        store,
    )


@app.get("/shop/store/{store_id}", response_class=HTMLResponse)
def glassify_store_alias(store_id: str) -> RedirectResponse:
    return RedirectResponse(f"/store/{store_id}", status_code=307)


@app.get("/cart", response_class=HTMLResponse)
def glassify_cart() -> str:
    return (STATIC / "shop-cart.html").read_text(encoding="utf-8")


@app.get("/shop-demo", response_class=HTMLResponse)
def shop_demo() -> str:
    """Fake merchant storefront: one script + SKU buttons."""
    return (STATIC / "shop-demo.html").read_text(encoding="utf-8")


@app.get("/for-brands", response_class=HTMLResponse)
def for_brands() -> RedirectResponse:
    return RedirectResponse("/")


@app.get("/admin", response_class=HTMLResponse)
def admin_home(request: Request):
    if not is_authed(request):
        return RedirectResponse("/admin/login")
    return (STATIC / "admin-index.html").read_text(encoding="utf-8")


@app.get("/admin/login", response_class=HTMLResponse)
def login_page(request: Request):
    if is_authed(request):
        return RedirectResponse("/admin")
    return (STATIC / "login.html").read_text(encoding="utf-8")


@app.post("/api/admin/login")
def api_login(password: str = Form(...)) -> Response:
    if not check_password(password):
        raise HTTPException(status_code=401, detail="Şifrə yanlışdır.")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        COOKIE_NAME,
        session_token(),
        httponly=True,
        samesite="lax",
        max_age=7 * 24 * 3600,
    )
    return resp


@app.post("/api/admin/logout")
def api_logout() -> Response:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME)
    return resp


@app.get("/partner/login", response_class=HTMLResponse)
def partner_login_page(request: Request):
    if partner_slug(request):
        return RedirectResponse("/partner")
    return (STATIC / "partner-login.html").read_text(encoding="utf-8")


@app.get("/partner", response_class=HTMLResponse)
def partner_home(request: Request):
    if not partner_slug(request):
        return RedirectResponse("/partner/login")
    return (STATIC / "partner.html").read_text(encoding="utf-8")


@app.post("/api/partner/login")
def api_partner_login(slug: str = Form(...), password: str = Form(...)) -> Response:
    slug = slug.strip().lower()
    if get_brand(slug) is None or not check_partner_password(slug, password):
        raise HTTPException(status_code=401, detail="Mağaza kodu və ya şifrə yanlışdır.")
    resp = JSONResponse({"ok": True, "slug": slug})
    resp.set_cookie(
        PARTNER_COOKIE,
        partner_cookie_value(slug),
        httponly=True,
        samesite="lax",
        max_age=7 * 24 * 3600,
    )
    return resp


@app.post("/api/partner/logout")
def api_partner_logout() -> Response:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(PARTNER_COOKIE)
    return resp


@app.get("/api/partner/me")
def api_partner_me(request: Request) -> dict:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    brand = get_brand(slug)
    if brand is None:
        raise HTTPException(status_code=404, detail="Mağaza tapılmadı.")
    return {
        "slug": slug,
        "name": brand["name"],
        "store_mode": brand.get("store_mode") or "",
    }


@app.post("/api/partner/mode")
def api_partner_mode(request: Request, store_mode: str = Form(...)) -> dict:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    if store_mode not in ("own_site", "hosted"):
        raise HTTPException(status_code=400, detail="Yanlış seçim.")
    return public_brand(update_brand(slug, store_mode=store_mode))


@app.post("/api/applications")
def api_apply(
    name: str = Form(...),
    store: str = Form(...),
    contact: str = Form(...),
    has_site: str = Form("no"),
    message: str = Form(""),
) -> dict:
    try:
        return save_application(name, store, contact, has_site in ("yes", "true", "1"), message)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/applications")
def api_list_applications(request: Request) -> list[dict]:
    require_admin_api(request)
    return load_applications()


@app.post("/api/applications/{app_id}/approve")
def api_approve_application(
    request: Request,
    app_id: str,
    slug: str = Form(...),
    password: str = Form(...),
) -> dict:
    require_admin_api(request)
    try:
        return approve_application(app_id, slug, password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/admin/{slug}", response_class=HTMLResponse)
def admin(slug: str, request: Request):
    if not is_authed(request):
        return RedirectResponse("/admin/login")
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    return (STATIC / "admin.html").read_text(encoding="utf-8")


@app.post("/api/brand/{slug}/frames")
async def upload_frame(
    request: Request,
    slug: str,
    sku: str = Form(...),
    name: str = Form(...),
    brand: str = Form(""),
    price: str = Form(""),
    category: str = Form("optical"),
    marketplace: str = Form(""),
    file: UploadFile = File(...),
) -> dict:
    require_store_access(request, slug)
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    data = await file.read()
    price_val = None
    raw_price = (price or "").strip().replace(",", ".")
    if raw_price:
        try:
            price_val = float(raw_price)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Qiymət düzgün deyil.") from exc
    published = marketplace.strip().lower() in ("1", "true", "yes", "on")
    try:
        return save_uploaded_frame(
            slug,
            sku.strip(),
            name.strip(),
            brand.strip(),
            data,
            price=price_val,
            filter_key=category.strip() or "optical",
            published=published,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail="Şəkil açılmadı — şəffaf fonlu PNG və ya JPG yükləyin.",
        ) from exc


@app.post("/api/brand/{slug}/frames/{sku}/marketplace")
def api_frame_marketplace(
    request: Request,
    slug: str,
    sku: str,
    marketplace: str = Form(...),
    price: str = Form(""),
) -> dict:
    require_store_access(request, slug)
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    published = marketplace.strip().lower() in ("1", "true", "yes", "on")
    price_val = None
    raw_price = (price or "").strip().replace(",", ".")
    if raw_price:
        try:
            price_val = float(raw_price)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Qiymət düzgün deyil.") from exc
    try:
        return set_frame_marketplace(slug, sku, published, price_val)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/media/{slug}/{filename}")
def media(slug: str, filename: str) -> FileResponse:
    path = media_path(slug, filename)
    if path is None:
        raise HTTPException(status_code=404, detail="Fayl yoxdur.")
    return FileResponse(path, media_type="image/png")


@app.get("/api/brands")
def api_brands() -> list[dict]:
    return list_brands()


@app.get("/ql2009/{filename}")
def ql2009_asset(filename: str) -> FileResponse:
    """Serve the QL2009 C1 production-test 3D / DeepAR files only."""
    if filename not in QL2009_PUBLIC:
        raise HTTPException(status_code=404, detail="Fayl yoxdur.")
    path = QL2009_EXPORT / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="DeepAR effekti hələ export olunmayıb.")
    media = "model/gltf-binary" if filename.endswith(".glb") else "application/octet-stream"
    return FileResponse(path, media_type=media, filename=filename)


@app.get("/api/vto/status")
def vto_status() -> dict:
    return {"configured": tryoncloud_configured(), "provider": "tryoncloud"}


@app.post("/api/vto/try")
async def vto_try(
    photo: UploadFile = File(...),
    product_id: str = Form(...),
) -> Response:
    """Photo try-on via TryOnCloud. The provider key never leaves this server."""
    product = get_product(product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Məhsul tapılmadı.")
    garment = garment_path(product)
    if garment is None:
        raise HTTPException(status_code=500, detail="Eynək şəkli tapılmadı.")
    person = await photo.read()
    if not person:
        raise HTTPException(status_code=400, detail="Şəkil boşdur.")
    try:
        result = generate_tryon(
            tryoncloud_api_key(),
            person,
            garment.read_bytes(),
            photo.filename or "person.jpg",
            garment.name,
        )
    except TryOnCloudError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return Response(content=result, media_type="image/png")


@app.get("/api/tryon-config")
def tryon_config() -> dict:
    """Client reads this before starting AR. License key is domain-locked by DeepAR."""
    key = os.environ.get("DEEPAR_LICENSE_KEY", "").strip()
    return {
        "engine": "deepar" if key else "overlay",
        "licenseKey": key or None,
        "rootPath": "/static/vendor/deepar/",
        "defaultEffect": "/static/vendor/deepar/effects/aviators",
    }


@app.get("/api/health")
def health() -> dict:
    key = bool(os.environ.get("DEEPAR_LICENSE_KEY", "").strip())
    return {"ok": True, "product": "white-label-vto", "engine": "deepar" if key else "overlay"}


@app.post("/api/leads")
def api_leads(
    name: str = Form(...),
    store: str = Form(...),
    contact: str = Form(...),
    message: str = Form(""),
) -> dict:
    try:
        return save_lead(name, store, contact, message)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/brands")
def api_create_brand(request: Request, slug: str = Form(...), name: str = Form(...)) -> dict:
    require_admin_api(request)
    try:
        return create_brand(slug, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/brand/{slug}/frames/{sku}/calibrate")
def api_calibrate(
    request: Request,
    slug: str,
    sku: str,
    scale: float = Form(...),
    offset_x: float = Form(0.0),
    offset_y: float = Form(-0.1),
) -> dict:
    require_store_access(request, slug)
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    try:
        return update_calibration(slug, sku, scale, offset_x, offset_y)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/brand/{slug}/frames/{sku}/angles")
async def api_add_angle(
    request: Request,
    slug: str,
    sku: str,
    file: UploadFile = File(...),
) -> dict:
    require_store_access(request, slug)
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    data = await file.read()
    try:
        return add_angle(slug, sku, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail="Şəkil açılmadı — PNG və ya JPG yükləyin.",
        ) from exc


@app.delete("/api/brand/{slug}/frames/{sku}")
def api_delete_frame(request: Request, slug: str, sku: str) -> dict:
    require_store_access(request, slug)
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    try:
        delete_frame(slug, sku)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@app.get("/api/brand/{slug}/qr.png")
def brand_qr(slug: str, request: Request) -> Response:
    """QR code pointing at the brand's hosted micro-page (print / shop window)."""
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    target = str(request.base_url).rstrip("/") + f"/t/{slug}"
    img = qrcode.make(target, box_size=8, border=2)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@app.post("/api/brand/{slug}/track")
def api_track(slug: str, event: str = Form(...)) -> dict:
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    try:
        return bump_stat(slug, event)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/brand/{slug}/stats")
def api_stats(request: Request, slug: str) -> dict:
    require_store_access(request, slug)
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    return get_stats(slug)


@app.post("/api/brand/{slug}/settings")
def api_brand_settings(
    request: Request,
    slug: str,
    accent: str = Form("#1f4d3a"),
    cart_url: str = Form(""),
) -> dict:
    require_store_access(request, slug)
    try:
        return save_brand_settings(slug, accent, cart_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/brand/{slug}/domains")
def api_domains(request: Request, slug: str, domains: str = Form("")) -> dict:
    require_store_access(request, slug)
    try:
        return {"allowed_domains": update_domains(slug, domains)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/brand/{slug}")
def brand(slug: str) -> dict:
    data = brand_payload(slug)
    if data is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    return data


@app.get("/api/frames")
def frames() -> list[dict]:
    return [{**item, "image_url": f"/frames/{item['id']}.png"} for item in get_catalog()]


@app.post("/api/tryon")
async def tryon(
    image: UploadFile = File(...),
    sku: str = Form(...),
) -> Response:
    """Photo overlay for WhatsApp / Instagram DM. Web live try-on stays on-device."""
    if get_frame(sku) is None:
        raise HTTPException(status_code=400, detail="Naməlum eynək modeli.")
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Şəkil boşdur.")
    try:
        result = overlay_bytes(data, sku)
    except NoFaceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Overlay xətası: {exc}") from exc

    buf = BytesIO()
    result.save(buf, format="JPEG", quality=90)
    return Response(content=buf.getvalue(), media_type="image/jpeg")


@app.exception_handler(HTTPException)
async def http_error(_, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
