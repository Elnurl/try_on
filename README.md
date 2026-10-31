# Eynek VTO

Eyewear virtual try-on service: product photos → 2.5D try-on asset → one-script SDK for any website.

- **Pipeline** (`app/pipeline.py`): background removal (uniform-background cut, `rembg` fallback), temple-tip crop,
  lens detection (clear lenses become see-through, tinted lenses stay translucent), real frame width from the
  lens size (`49-18-142`), hinge height, frame/temple colour and finish from the side photos.
- **Runtime** (`app/static/sdk/vto-core.js`): MediaPipe Face Landmarker pose (eye line + facial matrix), mm-accurate
  scale, bent photo front with lens glare and contact shadow, extruded 3D temples that splay to the ears, invisible
  head occluder so far temples hide behind the head, One Euro smoothing.
- **Embed** (`/embed?store=&sku=`): camera try-on, selfie fallback, product strip, snapshot, add-to-cart message.
- **SDK** (`/sdk/eynek-vto.js`): modal iframe, `data-eynek-vto` buttons, `<eynek-vto variant-id>` element
  (TINT-compatible), `EynekVTO.open / isAvailable / products / on`.
- **Studio** (`/studio`): sellers upload 3 photos + sizes, see a 3D preview, try it on camera, manage products.
- **Admin** (`/admin`): create stores, rotate API keys, issue seller upload links.

## Website integration

```html
<script src="https://tryon-wa.onrender.com/sdk/eynek-vto.js" data-store="STORE_ID" async></script>
<button data-eynek-vto="SKU" data-eynek-hide-missing>Üzündə yoxla</button>
```

```js
EynekVTO.open({ sku: "SKU" });
EynekVTO.isAvailable("SKU").then((ok) => {});
EynekVTO.on("add-to-cart", ({ sku }) => addToCart(sku));
```

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/products` | store key or upload token | multipart `sku, name, sizes, width_mm, front, left, right` |
| GET | `/v1/products` | store key or upload token | own products |
| DELETE | `/v1/products/{sku}` | store key or upload token | remove |
| POST | `/v1/upload-tokens` | store key | `{seller, ttl}` → `studioUrl` for a seller |
| GET | `/v1/stores/{store}/products[/{sku}]` | public | product list / manifest (404 = no VTO) |
| * | `/v1/admin/stores…` | `X-Admin-Password` | stores, keys, upload links |

Store keys go in `X-Api-Key` (or `Authorization: Bearer`). Upload tokens go in `X-Upload-Token` or `?token=`.
A token holder only sees and changes products uploaded with the same seller id.

## Run locally

```powershell
python -m venv .venv; .venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

Environment: `ADMIN_PASSWORD` (protects admin), `VTO_SECRET` (signs upload tokens; otherwise `data/secret.key`),
`PUBLIC_URL` (absolute asset URLs), `VTO_DATA_DIR` (defaults to `app/data`).

Data lives on disk: `data/stores.json` and `data/products/{store}/{sku}/` (manifest, processed front, thumbnail,
original photos). On Render this is the persistent disk mounted at `/srv/app/data`.
