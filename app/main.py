"""Virtual try-on API: live web widget + photo overlay for chat channels."""

from __future__ import annotations

import mimetypes
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

from app.auth import COOKIE_NAME, check_password, is_authed, session_token
from app.brands import brand_payload, get_brand, list_brands
from app.catalog import get_catalog, get_frame
from app.frames import FRAMES_DIR, ensure_frame_assets
from app.overlay import NoFaceError, overlay_bytes
from app.vendor_assets import ensure_vendor
from app.store import (
    add_angle,
    bump_stat,
    create_brand,
    delete_frame,
    get_stats,
    media_path,
    save_uploaded_frame,
    update_calibration,
    update_domains,
)

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")

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
    return response


def require_admin_api(request: Request) -> None:
    if not is_authed(request):
        raise HTTPException(status_code=401, detail="Giriş tələb olunur: /admin/login")


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
    return render_tryon("demo", "page")


@app.get("/t/{slug}", response_class=HTMLResponse)
def brand_page(slug: str) -> str:
    """Instagram bio / Taplink landing page."""
    return render_tryon(slug, "page")


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


@app.get("/shop-demo", response_class=HTMLResponse)
def shop_demo() -> str:
    """Fake merchant storefront: one script + SKU buttons."""
    return (STATIC / "shop-demo.html").read_text(encoding="utf-8")


@app.get("/for-brands", response_class=HTMLResponse)
def for_brands() -> str:
    return (STATIC / "brands.html").read_text(encoding="utf-8")


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
    file: UploadFile = File(...),
) -> dict:
    require_admin_api(request)
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    data = await file.read()
    try:
        return save_uploaded_frame(slug, sku.strip(), name.strip(), brand.strip(), data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail="Şəkil açılmadı — şəffaf fonlu PNG və ya JPG yükləyin.",
        ) from exc


@app.get("/media/{slug}/{filename}")
def media(slug: str, filename: str) -> FileResponse:
    path = media_path(slug, filename)
    if path is None:
        raise HTTPException(status_code=404, detail="Fayl yoxdur.")
    return FileResponse(path, media_type="image/png")


@app.get("/api/brands")
def api_brands() -> list[dict]:
    return list_brands()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "product": "white-label-vto"}


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
    require_admin_api(request)
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
    require_admin_api(request)
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
    require_admin_api(request)
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
    require_admin_api(request)
    if get_brand(slug) is None:
        raise HTTPException(status_code=404, detail="Brend tapılmadı.")
    return get_stats(slug)


@app.post("/api/brand/{slug}/domains")
def api_domains(request: Request, slug: str, domains: str = Form("")) -> dict:
    require_admin_api(request)
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
