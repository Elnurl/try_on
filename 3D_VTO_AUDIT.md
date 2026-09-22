# DeepAR 3D VTO audit

Inspected the existing DeepAR integration only. No code, packages, MediaPipe path, or marketplace work was changed.

Question this document answers: **can the current DeepAR hook become the premium 3D engine for store demos, or is it only a stub?**

Short answer: **the runtime can load real 3D glasses effects and switch them per SKU. Today it does not, because every demo SKU shares one sample effect, store uploads have no `effect_url`, and there are no real `.deepar` assets. Quality will come from those assets and the DeepAR license, not from rewriting MediaPipe.**

## Current DeepAR architecture

**SDK version:** DeepAR Web **5.6.22** (`app/vendor_assets.py` downloads `deepar-5.6.22.tgz`; vendored `package.json` reports the same version). Files are self-hosted at `/static/vendor/deepar/` (gitignored; fetched on boot). That matches the SDK’s own advice not to load from jsDelivr in production.

**How it turns on**

1. `GET /api/tryon-config` reads `DEEPAR_LICENSE_KEY`.
2. If the key is set: `{ engine: "deepar", licenseKey, rootPath: "/static/vendor/deepar/", defaultEffect: "/static/vendor/deepar/effects/aviators" }`.
3. If the key is missing: `{ engine: "overlay" }` — MediaPipe 2D PNG. That fallback stays.

**How the engine is initialized** (`createDeepAREngine` in `tryon-adapter.js`)

```js
deepar.initialize({
  licenseKey: config.licenseKey,
  previewElement: #ar-preview,
  rootPath: config.rootPath,
  effect: config.defaultEffect,  // aviators sample
  additionalOptions: { cameraConfig: { disableDefaultCamera: true } },
})
```

DeepAR then owns the camera (`startCamera` / `stopCamera`) and draws into `#ar-preview`. `live.js` hides `#camera` and `#stage` when `engine.kind === "deepar"`. The MediaPipe pose loop and PNG `drawGlasses()` do **not** run on this path.

**How a `.deepar` effect is loaded**

- On init: `effect` = default aviators URL.
- On SKU change / live start / photo: `setItem(item)` → `dar.switchEffect(item.effect_url || defaultEffect)`.

The official SDK types describe `switchEffect` as loading an AR effect file (URL or `ArrayBuffer`) into a slot, optionally attached to face 0–3. Their own examples use paths like `url/path/to/glasses` and `glasses2`. That is the intended per-model API.

## What is genuinely 3D today

When the license key is present and the SDK initializes:

- Face tracking is DeepAR’s **3D** tracker, not our 2-point eye overlay.
- The loaded file is a DeepAR **effect** (3D scene bound to the face), not a PNG billboard.
- Head turn, pitch, and depth come from that tracker + the meshes inside the effect.
- The bundled `effects/aviators` file is a **sample 3D glasses effect** that ships with the SDK. It is a real 3D try-on, but it is **one generic pair**, not a store SKU.

So: **the pipe is 3D. The catalog is not.**

## What is only 2D

- Default production path with no key: MediaPipe + PNG (`drawGlasses`).
- Demo “products” in `catalog.py` / `frames.py`: drawn placeholder PNGs.
- Store uploads (`save_uploaded_frame`): PNG + `scale` / `offset_*` only. **No `effect_url` is written.**
- Lens color swatches: overlay-only (`source-atop` on the PNG). They do nothing in DeepAR.
- `POST /api/tryon`: Python MediaPipe still image. Not DeepAR.
- Extra `angles[]` photos: gallery images, not 3D.

If DeepAR is on but a SKU has no `effect_url`, `setItem` falls back to **the same aviators sample**. Switching SKUs then looks like the same 3D glasses with a different rail label.

## Can a `.deepar` file be a complete 3D frame?

**Yes, as an authored DeepAR face effect — not as something our code assembles.**

DeepAR treats the file as one face-attached 3D scene. A glasses effect built in **DeepAR Studio** can include:

| Part | Who defines it |
|---|---|
| Front frame | 3D mesh in the `.deepar` |
| Lenses | 3D mesh / material in the `.deepar` |
| Temples | 3D mesh in the `.deepar` (visible when the head turns) |
| Depth | DeepAR 3D face pose + mesh placement |
| Head rotation | DeepAR tracker (not our `atan2` eye-line math) |

Our code does **not** place temples or lenses itself. It only `switchEffect(url)`. If the file is a poor or 2D-like effect, the result will look poor. If the file is a full glasses rig, DeepAR will render it as 3D VTO.

PNG calibration (`scale`, `offset_x`, `offset_y`) is **ignored** on the DeepAR path.

## How one real SKU would get its own 3D effect

No marketplace or engine rewrite required for the first SKU:

1. Model that exact frame in 3D (or have DeepAR / a studio do it).
2. Import into DeepAR Studio, bind to the face, export a `.deepar` (or the URL the SDK accepts).
3. Host the file (static path or `/media/{slug}/...`).
4. Set that SKU’s `effect_url` to that URL.
5. Ensure `DEEPAR_LICENSE_KEY` is valid for the page origin.
6. Existing `live.js` already calls `engine.setItem(item)` when the user picks the SKU.

README already states this: *“Hər real eynək üçün DeepAR Studio-da `.deepar` 3D effekt lazımdır — PNG kifayət etmir.”*

## Can every SKU have its own `effect_url`?

**Yes, in the data model and in the engine.**

- Demo rows in `catalog.py` already have an `effect_url` field.
- `setItem` uses `item.effect_url` first.
- SKU click already passes the full catalog item into `setItem`.

**Today they do not, in practice:** all five demo SKUs point at the same aviators URL. Uploaded SKUs have no field at all, so they all inherit the default.

## Does the architecture already support premium per-SKU 3D?

| Layer | Ready? |
|---|---|
| Adapter (`switchEffect` per item) | Yes |
| UI SKU switch → `setItem` | Yes |
| Catalog field `effect_url` | Yes (seed only) |
| Upload / partner panel writes `effect_url` | No |
| Hosting of `.deepar` per store | Not implemented (PNG only) |
| Real SKU 3D files | None (sample aviators only) |
| 2D fallback without a key | Yes — keep it |
| MediaPipe replacement | Not required for 3D path |

**Verdict:** existing DeepAR integration **can** be the premium 3D engine. The missing work is **assets + license + persisting `effect_url`**, not a new tracker.

## What would need to change (later — do not do this now)

1. Store a per-SKU `effect_url` on upload (and allow a `.deepar` file or URL).
2. Produce real DeepAR Studio effects per commercial SKU (or a small hero set for the first demo).
3. Buy / configure a DeepAR plan that matches how the widget is served (see license below).
4. Do **not** remove MediaPipe overlay; keep it when there is no key or no 3D file.
5. Do **not** expect PNG calibration or lens swatches to drive 3D.

Code change for switching effects is already done. The hard part is 3D content and commercial terms.

## Estimated technical complexity

| Work | Complexity |
|---|---|
| Keep adapter; set `effect_url` per SKU | Low |
| Upload/host `.deepar` next to PNG | Low–medium |
| First demo SKU with a real Studio effect | Medium (pipeline, not engine) |
| Full store catalog at Fittingbox look | High (one 3D asset per SKU) |
| Multi-store widget on many merchant domains | Unknown commercially (see below) |
| Removing watermark in **our** code | Not possible (no API in the vendored SDK types) |

## Important limitations (repo only — DeepAR was not contacted)

From `README.md`, `main.py`, `render.yaml`, and the vendored SDK types:

- The key is created on the DeepAR developer portal for a **web app**. README: register domains `tryon-wa.onrender.com` **and** `localhost`. `tryon-config` comment: *“License key is domain-locked by DeepAR.”*
- Free signup is documented as **10 MAU**.
- README backlog: the key is usually **one domain / one project**. Our widget can run on **many merchant origins**. The repo does **not** say how many domains one key allows. That is an open commercial risk for multi-store embed, not a code bug.
- `render.yaml` stores one `DEEPAR_LICENSE_KEY` for the Render service.
- Vendored `DeepAR.d.ts` has **no watermark, white-label, or logo API**. Nothing in app code hides a logo.
- Therefore: **this implementation cannot remove the DeepAR watermark.** If a commercial / white-label plan removes it, that would be DeepAR’s license behavior, not a change in `tryon-adapter.js`. The repo does not document that plan.

Other product limits:

- DeepAR path needs HTTPS (or localhost), camera permission, and a successful SDK + WASM load from **our** origin.
- Sample aviators is not a sellable catalog.
- Server photo overlay (`POST /api/tryon`) will stay 2D unless a separate DeepAR server path is added later.

## Conclusion

The current DeepAR integration is a **real 3D engine hook**, not a fake. It initializes Web SDK 5.6.22, loads a `.deepar` effect, and can `switchEffect` per catalog item.

It is **not** yet a premium eyewear VTO product, because the only 3D file is the SDK sample and every SKU shares it.

**Do not replace MediaPipe. Do not drop the 2D fallback.** Use DeepAR when a SKU has a real `effect_url` and a valid key; use overlay otherwise.

Next implementation step (when asked): one real SKU → one unique `.deepar` → one `effect_url`. That is the test of Fittingbox-class quality. The engine is already waiting for that file.
