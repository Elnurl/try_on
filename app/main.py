"""Virtual try-on API: live web widget + photo overlay for chat channels."""

from __future__ import annotations

import logging
import mimetypes
import os
import threading
from io import BytesIO
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
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
    auth_enabled,
    check_password,
    is_authed,
    partner_cookie_value,
    partner_slug,
    session_token,
)
from app.brands import brand_payload, get_brand, list_brands
from app.catalog import get_catalog, get_frame
from app.digitize25 import VTO25_DIR, load_manifest, prepare_bytes
from app.frames import FRAMES_DIR, ensure_frame_assets
from app.overlay import NoFaceError, overlay_bytes
from app.vendor_assets import ensure_vendor
from app.shop import (
    all_products,
    all_stores,
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
    load_orders,
    mark_notifications_read,
    media_path,
    pending_marketplace_products,
    public_brand,
    save_application,
    save_brand_settings,
    save_lead,
    save_order,
    save_uploaded_frame,
    seller_dashboard,
    seller_finance,
    seller_notifications,
    seller_orders,
    set_frame_marketplace,
    set_listing_status,
    update_brand,
    update_calibration,
    update_domains,
    update_frame_inventory,
    update_seller_order_status,
    update_seller_settings,
)

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".deepar")

QL2009_EXPORT = ROOT.parent / "assets" / "ql2009" / "export"
QL2009_PUBLIC = {"QL2009_C1.deepar", "QL2009_C1.glb", "QL2009_C1.fbx"}

ensure_frame_assets()

app = FastAPI(title="tryon-wa", version="0.6.0")


_log = logging.getLogger("tryon")


def _bootstrap_vendor() -> None:
    try:
        ensure_vendor()
    except Exception as exc:  # noqa: BLE001
        _log.warning("Vendor bootstrap failed (will retry on demand): %s", exc)


threading.Thread(target=_bootstrap_vendor, name="vendor-bootstrap", daemon=True).start()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
app.mount("/frames", StaticFiles(directory=FRAMES_DIR), name="frames")
app.mount("/vto25", StaticFiles(directory=VTO25_DIR), name="vto25")
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


def require_studio_upload(request: Request) -> None:
    """Photo → VTO studio: open when no admin password, or STUDIO_PUBLIC_UPLOAD=1, or logged in."""
    if not auth_enabled():
        return
    if is_authed(request):
        return
    public = os.environ.get("STUDIO_PUBLIC_UPLOAD", "1").strip().lower()
    if public in ("1", "true", "yes", "on"):
        return
    raise HTTPException(
        status_code=401,
        detail="Studio upload üçün /admin/login ilə daxil olun və ya STUDIO_PUBLIC_UPLOAD=1 təyin edin.",
    )


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
def home() -> RedirectResponse:
    """Consumer homepage — marketplace catalog."""
    return RedirectResponse("/shop", status_code=307)


@app.get("/sell", response_class=HTMLResponse)
def sell_landing() -> str:
    """Seller / partner apply page."""
    return (STATIC / "landing.html").read_text(encoding="utf-8")


@app.get("/studio", response_class=HTMLResponse)
def vto_studio() -> str:
    """Upload a glasses photo and preview it on a model face."""
    return (STATIC / "studio.html").read_text(encoding="utf-8")


@app.get("/engine", response_class=HTMLResponse)
def vto_engine() -> str:
    """Owned try-on SDK demo — MediaPipe + parametric 3D frames."""
    return (STATIC / "engine.html").read_text(encoding="utf-8")


@app.get("/try", response_class=HTMLResponse)
def vto_try_page() -> str:
    """Own engine: uploaded glasses photo placed on the user's face."""
    return (STATIC / "try.html").read_text(encoding="utf-8")


@app.get("/robots.txt")
def robots() -> Response:
    body = "User-agent: *\nAllow: /\nSitemap: https://xn--eynk-x6b.com/sitemap.xml\n"
    return Response(content=body, media_type="text/plain; charset=utf-8")


@app.get("/sitemap.xml")
def sitemap(request: Request) -> Response:
    base = str(request.base_url).rstrip("/")
    urls = [f"{base}/shop", f"{base}/sell", f"{base}/cart"]
    for product in all_products():
        urls.append(f"{base}/product/{product['id']}")
    for store in all_stores():
        urls.append(f"{base}/store/{store['id']}")
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for loc in urls:
        parts.append(f"  <url><loc>{loc}</loc></url>")
    parts.append("</urlset>")
    return Response(content="\n".join(parts) + "\n", media_type="application/xml; charset=utf-8")


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
    return RedirectResponse("/sell")


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
        "city": brand.get("city") or "",
        "tagline": brand.get("tagline") or "",
        "contact": brand.get("contact") or "",
        "address": brand.get("address") or "",
        "hours": brand.get("hours") or "",
        "instagram": brand.get("instagram") or "",
        "website": brand.get("website") or "",
        "description": brand.get("description") or "",
    }


@app.get("/api/partner/dashboard")
def api_partner_dashboard(request: Request) -> dict:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    return seller_dashboard(slug)


@app.get("/api/partner/orders")
def api_partner_orders(request: Request) -> list[dict]:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    return seller_orders(slug)


@app.post("/api/partner/orders/{order_id}/status")
def api_partner_order_status(
    request: Request,
    order_id: str,
    status: str = Form(...),
) -> dict:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    try:
        return update_seller_order_status(slug, order_id, status.strip().lower())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/partner/finance")
def api_partner_finance(request: Request) -> dict:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    return seller_finance(slug)


@app.get("/api/partner/notifications")
def api_partner_notifications(request: Request) -> list[dict]:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    return seller_notifications(slug)


@app.post("/api/partner/notifications/read")
def api_partner_notifications_read(request: Request) -> dict:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    return {"ok": True, "marked": mark_notifications_read(slug)}


@app.post("/api/partner/settings")
async def api_partner_settings(request: Request) -> dict:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    content_type = (request.headers.get("content-type") or "").lower()
    if "application/json" in content_type:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Yanlış məlumat.")
    else:
        form = await request.form()
        payload = {k: str(form.get(k) or "") for k in form.keys()}
    try:
        return update_seller_settings(slug, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/partner/frames/{sku}/inventory")
def api_partner_inventory(
    request: Request,
    sku: str,
    stock: str = Form(""),
    status: str = Form(""),
    price: str = Form(""),
    marketplace: str = Form(""),
) -> dict:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    stock_val = None
    price_val = None
    status_val = None
    market_val = None
    if stock.strip() != "":
        try:
            stock_val = int(stock)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Stok düzgün deyil.") from exc
    if price.strip() != "":
        try:
            price_val = float(price.replace(",", "."))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Qiymət düzgün deyil.") from exc
    if status.strip():
        status_val = status.strip().lower()
    if marketplace.strip() != "":
        market_val = marketplace.strip().lower() in ("1", "true", "yes", "on")
    try:
        return update_frame_inventory(
            slug,
            sku,
            stock=stock_val,
            status=status_val,
            price=price_val,
            marketplace=market_val,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/partner/mode")
def api_partner_mode(request: Request, store_mode: str = Form(...)) -> dict:
    slug = partner_slug(request)
    if not slug:
        raise HTTPException(status_code=401, detail="Giriş tələb olunur.")
    if store_mode not in ("own_site", "hosted"):
        raise HTTPException(status_code=400, detail="Yanlış seçim.")
    return public_brand(update_brand(slug, store_mode=store_mode))


@app.get("/api/admin/pending-products")
def api_admin_pending_products(request: Request) -> list[dict]:
    require_admin_api(request)
    return pending_marketplace_products()


@app.post("/api/admin/products/{slug}/{sku}/status")
def api_admin_product_status(
    request: Request,
    slug: str,
    sku: str,
    status: str = Form(...),
) -> dict:
    require_admin_api(request)
    status = status.strip().lower()
    if status not in ("approved", "rejected", "pending"):
        raise HTTPException(status_code=400, detail="Yanlış status.")
    try:
        return set_listing_status(slug, sku, status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
    scale: str = Form(""),
    offset_x: str = Form(""),
    offset_y: str = Form(""),
    tryon: str = Form(""),
    file: UploadFile = File(...),
    model: UploadFile | None = File(None),
    extra: Annotated[list[UploadFile] | None, File()] = None,
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
    tryon_on = tryon.strip().lower() in ("1", "true", "yes", "on")

    def _opt_float(raw: str) -> float | None:
        text = (raw or "").strip().replace(",", ".")
        if not text:
            return None
        try:
            return float(text)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Kalibr rəqəmi düzgün deyil.") from exc

    glb_bytes = await model.read() if model is not None else None
    if glb_bytes == b"":
        glb_bytes = None
    extra_png: list[bytes] = []
    for upload in extra or []:
        chunk = await upload.read()
        if chunk:
            extra_png.append(chunk)
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
            scale=_opt_float(scale),
            offset_x=_opt_float(offset_x),
            offset_y=_opt_float(offset_y),
            tryon=True if tryon_on else None,
            glb_bytes=glb_bytes,
            extra_png_bytes=extra_png,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail="Şəkil açılmadı — şəffaf fonlu PNG və ya JPG yükləyin.",
        ) from exc


@app.post("/api/studio/publish")
async def studio_publish(
    request: Request,
    slug: str = Form("demo"),
    sku: str = Form(...),
    name: str = Form(...),
    brand: str = Form("Studio"),
    scale: str = Form(""),
    offset_x: str = Form("0"),
    offset_y: str = Form(""),
    frame_width_mm: str = Form(""),
    file: UploadFile = File(...),
    model: UploadFile | None = File(None),
    extra: Annotated[list[UploadFile] | None, File()] = None,
) -> dict:
    """Şəkil → kataloq + VTO link (studio axını, cədvəl addım 1–3)."""
    require_studio_upload(request)
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")

    def _opt_float(raw: str) -> float | None:
        text = (raw or "").strip().replace(",", ".")
        if not text:
            return None
        try:
            return float(text)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Kalibr rəqəmi düzgün deyil.") from exc

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Ön şəkil boşdur.")
    glb_bytes = await model.read() if model is not None else None
    if glb_bytes == b"":
        glb_bytes = None
    if not glb_bytes:
        raise HTTPException(status_code=400, detail="VTO modeli (GLB) yoxdur — ön şəkli yenidən yükləyin.")
    extra_png: list[bytes] = []
    for upload in extra or []:
        chunk = await upload.read()
        if chunk:
            extra_png.append(chunk)
    try:
        item = save_uploaded_frame(
            slug.strip(),
            sku.strip(),
            name.strip(),
            brand.strip(),
            data,
            tryon=True,
            scale=_opt_float(scale),
            offset_x=_opt_float(offset_x),
            offset_y=_opt_float(offset_y),
            glb_bytes=glb_bytes,
            extra_png_bytes=extra_png,
            frame_width_mm=_opt_float(frame_width_mm),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Şəkil emal olunmadı.") from exc
    tryon_path = f"/t/{slug.strip()}?sku={item['id']}"
    return {
        "ok": True,
        "sku": item["id"],
        "tryon_url": tryon_path,
        "angles": len(item.get("angles") or []),
        "item": item,
    }


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
    media = "model/gltf-binary" if filename.endswith(".glb") else "image/png"
    return FileResponse(path, media_type=media)


@app.get("/api/brands")
def api_brands() -> list[dict]:
    return list_brands()


def _ql2009_file(filename: str) -> FileResponse:
    if filename not in QL2009_PUBLIC:
        raise HTTPException(status_code=404, detail="Fayl yoxdur.")
    path = QL2009_EXPORT / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="DeepAR effekti hələ export olunmayıb.")
    media = "model/gltf-binary" if filename.endswith(".glb") else "application/octet-stream"
    return FileResponse(path, media_type=media, filename=filename)


@app.get("/ql2009/{filename}")
def ql2009_asset(filename: str) -> FileResponse:
    """Serve the QL2009 C1 production-test 3D / DeepAR files only."""
    return _ql2009_file(filename)


@app.head("/ql2009/{filename}")
def ql2009_asset_head(filename: str) -> FileResponse:
    return _ql2009_file(filename)


@app.get("/api/vto/status")
def vto_status() -> dict:
    return {"configured": tryoncloud_configured(), "provider": "tryoncloud"}


@app.post("/api/vto/prepare")
async def vto_prepare(
    photo: UploadFile = File(...),
    width_mm: float = Form(135),
) -> dict:
    """Photo → 3D digitize: cutout, contour, rim, hinges, manifest."""
    data = await photo.read()
    if not data:
        raise HTTPException(status_code=400, detail="Şəkil boşdur.")
    try:
        return prepare_bytes(data, width_mm=max(80.0, min(180.0, width_mm)), filename=photo.filename or "g.png")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/vto/asset/{out_id}")
def vto_asset(out_id: str) -> dict:
    manifest = load_manifest(out_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail="Asset tapılmadı.")
    return manifest


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
    ql_deepar = (QL2009_EXPORT / "QL2009_C1.deepar").is_file()
    return {
        "engine": "deepar" if key else "overlay",
        "licenseKey": key or None,
        "rootPath": "/static/vendor/deepar/",
        "defaultEffect": "/static/vendor/deepar/effects/aviators",
        "deeparEffects": {
            "ql2009-c1": ql_deepar,
        },
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


@app.post("/api/orders")
async def api_orders(request: Request) -> dict:
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="JSON gözlənilir.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Yanlış sorğu.")
    try:
        return save_order(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/orders")
def api_list_orders(request: Request) -> list[dict]:
    require_admin_api(request)
    rows = load_orders()
    rows.sort(key=lambda row: row.get("at") or "", reverse=True)
    return rows


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
