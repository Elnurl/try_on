# VTO technical audit

Inspected the existing `tryon-wa` repo only. No engine code, packages, or VTO behavior was changed. Production reference: `https://tryon-wa.onrender.com/`.

## Current VTO technology

The live experience is **on-device**. Video never goes to the server.

There are two client engines behind one factory (`app/static/tryon-adapter.js` → `createTryonEngine()`):

| Engine | When it runs | What it does |
|---|---|---|
| **overlay** (default) | No `DEEPAR_LICENSE_KEY` | MediaPipe Face Landmarker (WASM, self-hosted under `/static/vendor/mediapipe/`). 468-point face mesh. A 2D PNG is drawn on a canvas. |
| **deepar** | `DEEPAR_LICENSE_KEY` is set | DeepAR Web **5.6.22**. 3D face tracking and a `.deepar` effect. DeepAR owns the camera/preview. |

`GET /api/tryon-config` chooses the engine. UI (`live.js`) stays engine-agnostic.

A **separate** server path exists for still photos only: `POST /api/tryon` uses **Python MediaPipe** (`app/overlay.py`) and returns a JPEG. That is for chat/DM overlays, not the live web session.

## How live tracking works

**Overlay (the real default MVP path)**

1. User consents, then `getUserMedia({ facingMode: "user", width: 1280, height: 720 })`.
2. `requestAnimationFrame` loop: copy the mirrored video frame to `#stage`.
3. On each **new** `video.currentTime`, `landmarker.detectForVideo(video, timestamp)` runs (`runningMode: "VIDEO"`).
4. Eye centers are averaged from landmarks **33/133** (left) and **362/263** (right).
5. Pose is converted to pixels (mirrored), then **adaptively smoothed** (small motion = more smoothing; fast turns = less lag).
6. The selected frame PNG is scaled to `eyeDistance * sku.scale`, rotated to the eye line, and shifted by `offset_x` / `offset_y`.

If the same video timestamp repeats, the last smoothed pose is redrawn (no extra detect). GPU delegate is tried first; CPU is the fallback.

**This is genuine real-time tracking**, not a slideshow. It is **2D billboard overlay**, not a 3D glasses mesh fitted to the face.

**DeepAR path**

`startCamera()` / `switchEffect(effect_url)`. Live loop and PNG draw are skipped. Today every demo SKU points at the same bundled effect: `/static/vendor/deepar/effects/aviators`. DeepAR watermark remains unless the DeepAR plan allows white-label.

**Photo mode**

Camera stops. Overlay switches to `runningMode: "IMAGE"` and runs `detect()` once on the file. DeepAR uses `processImage()`. Lens color tint is overlay-only (canvas `source-atop`).

## How frames are represented

A **frame** is the VTO asset + calibration, keyed by **`id` (SKU)**.

```
id, name, name_az, brand, model
scale, offset_x, offset_y
lenses[]          # hex tints for overlay
effect_url        # DeepAR effect (optional)
image_url         # PNG for overlay + catalog
custom            # uploaded by a store
angles[]          # extra product photos, not used for tracking
```

- Demo SKUs live in `app/catalog.py`. PNGs are **generated drawings** (`app/frames.py`), not real product photos.
- Store uploads live in `app/data/stores/{slug}/catalog.json` + `frames/{sku}.png`.
- `GET /api/brand/{slug}` merges seed catalog (if `seed: true`) with that store’s extras.

## How products are represented

There is **no separate product table**. The catalog row **is** the product. Commerce fields (price, stock, checkout) are not first-class.

Identity is already SKU-shaped:

- Widget: `<button class="try-on-btn" data-sku="round-black">`
- Embed: `/embed?brand={slug}&sku={id}`
- Hosted try-on: `/t/{slug}?sku={id}` (`tryon.html` `data-sku`)
- Server overlay: `POST /api/tryon` with `sku`

`live.js` selects `catalog.find(item => item.id === wanted)`. Connecting a future commerce product to a frame means: **`product.frame_id` / `product.sku` = catalog `id`**. That join already works.

## Current backend and storage

- **Backend:** FastAPI (`app/main.py`), Python 3.10, Docker on Render (persistent disk). Not Vercel.
- **Database:** none. JSON on disk: `brands.json`, per-store `catalog.json` / `stats.json`, `applications.json`.
- **Tenancy:** `slug` on the brand. Widget uses `data-store-id`.
- **Privacy:** live video stays in the browser. Server sees only anonymous counters (`open` / `tryon` / `click`).

## Is live VTO suitable for a production MVP?

**Yes, as a 2D live try-on MVP**, if each SKU has a real front-facing transparent PNG and calibration is tuned.

**No, as a Zenni / Fittingbox-quality 3D product**, until each SKU has its own 3D effect (or another 3D engine) and DeepAR licensing matches multi-domain widgets.

| Suitable now | Not suitable yet |
|---|---|
| Real-time face follow on phone/desktop | Depth, temples, true 3D fit |
| “See this pair on my face” | Photoreal product marketing |
| SKU-level switch in one session | One DeepAR effect for all demo SKUs |
| Embed via iframe (WASM stays off merchant origin) | Unpaid DeepAR without watermark |

Jitter is reduced by smoothing; lag on fast motion is a tradeoff. Overlay quality is capped by the PNG, not by the tracker.

## Can a product map to a specific frame ID?

**Yes.** `id` is already the frame key. Widget, embed, URL, and `POST /api/tryon` all pass that SKU. Do not invent a second ID for the engine. Add commerce fields **next to** `id`, or a product row that points at `id`.

## What is already good

- Engine adapter: MediaPipe / DeepAR / a future engine can swap without rewriting `live.js`.
- On-device camera; self-hosted MediaPipe (important in Azerbaijan).
- Live vs photo is explicit (`VIDEO` / `IMAGE`).
- Per-SKU calibration (`scale`, `offset_*`).
- SKU already connects UI → catalog → overlay.
- Multi-store `slug` and embed widget already exist.
- Iframe widget keeps WASM off the merchant site.

## What must be changed (for commerce later — not now)

- Treat **product** (price, title, store, cart) as a different object from **frame** (PNG, calibration, `effect_url`).
- Replace drawn demo PNGs with real SKU photos (and later per-SKU 3D).
- Persist catalog in a real store when JSON files are no longer enough.
- Stop pointing every DeepAR SKU at the same aviators effect.
- Confirm DeepAR domain/tenant limits before selling 3D embeds to many sites.

## What should NOT be changed

- `tryon-adapter.js` contract (`detectVideo`, `detectImage`, `setItem`, `kind`).
- Landmark indices and the overlay math in `drawGlasses` / `smoothPose`.
- On-device camera (do not stream video to the server for live try-on).
- SKU `id` as the frame key.
- Self-hosted MediaPipe vendor path.
- Existing live/photo behavior until a new engine is deliberately adopted.

## Recommended architecture (do not implement yet)

Keep the VTO engine as a **read-only consumer** of a frame record.

```
Store (slug)
  └── Product (commerce: name, price, cart_url, …)
        └── frame_id == catalog.id
              ├── overlay: PNG + scale/offset
              └── optional: effect_url (3D)
```

- **Store has a website:** widget `data-store-id` + `data-sku`. Cart stays on their site.
- **Store has no website:** hosted catalog lists products; “Virtual sına” opens `/t/{slug}?sku=`.
- Engine keeps calling `GET /api/brand/{slug}` (or a future `/api/frames/{slug}/{id}`). Same pose loop.
- JSON is enough for a small pilot. Move to Postgres (or similar) when many stores and SKUs need transactions and backups.

**Order of work later:** product model + SKU join → real PNGs → then 3D assets. Do not replace the live overlay loop until those assets exist.
