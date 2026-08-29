# tryon-wa — white-label VTO

Yerli optika üçün **no-code Virtual Try-On integrator**. 2D overlay (MediaPipe) default-dur. Realistik 3D üçün DeepAR Web SDK adapter arxasındadır — `DEEPAR_LICENSE_KEY` olanda avtomatik yandırılır.

## 3D (DeepAR) — sən etməlisən

1. https://developer.deepar.ai/signup — hesab aç (10 MAU pulsuz).
2. Project yarat → Web app əlavə et. Domain: `tryon-wa.onrender.com` **və** `localhost`.
3. License key-i kopyala.
4. Render dashboard → Environment → `DEEPAR_LICENSE_KEY` = həmin açar → **Save** (servis yenidən start olur).

Açar yoxdursa sayt 2D demo ilə işləməyə davam edir. Hər real eynək üçün sonradan DeepAR Studio-da `.deepar` 3D effekt lazımdır — PNG kifayət etmir.

## 3 komponent

1. **Engine** — `/embed` canlı kamera (müştəri səhifəsində WASM yox, iframe)
2. **Widget** — 1 sətir JS: `/vto-widget.js` + `.try-on-btn[data-sku]`
3. **Kanal 2** — WhatsApp/DM üçün `POST /api/tryon` (şəkil overlay). Admin dashboard sonra.

## Demo

```powershell
cd C:\Users\Elnur\Projects\tryon-wa
.\.venv\Scripts\uvicorn.exe app.main:app --reload --host 127.0.0.1 --port 8000
```

- Mağaza saytı (widget): http://127.0.0.1:8000/shop-demo
- Bio səhifə: http://127.0.0.1:8000/t/demo
- Brend snippet: http://127.0.0.1:8000/for-brands
- Platform admin (brend yarat): http://127.0.0.1:8000/admin
- Brend paneli: http://127.0.0.1:8000/admin/demo — kataloq, kalibr, QR kod, statistika, domen whitelist

## Arxitektura qeydləri

- **Engine adapter**: üz izləmə yalnız `app/static/tryon-adapter.js` üzərindən çağırılır
  (unified `createTryonEngine()` interfeysi). MediaPipe-dan DeepAR/Fittingbox-a keçmək =
  yalnız bu faylı dəyişmək; `live.js`, kataloq və panellər toxunulmaz qalır.
- **QR kod**: `GET /api/brand/{slug}/qr.png` → `/t/{slug}` mikro-səhifəyə yönləndirir.
- **Domen whitelist**: brend paneldən doldurulur; `/embed` Referer-i yoxlayır (boşdursa hər yerdə işləyir).
- **Statistika**: `open` / `tryon` / `click` hadisələri `POST /api/brand/{slug}/track` ilə sayılır
  (billing üçün baza). Video/şəkil heç vaxt serverə getmir.
- **Admin auth**: `ADMIN_PASSWORD` env dəyişəni təyin olunanda `/admin*` səhifələri və bütün
  dəyişiklik edən API-lar login tələb edir (session cookie, 7 gün). Lokal dev-də boş saxla —
  qorunma sönülü qalır.

## Deploy (Render — Vercel YOX)

Vercel serverless-dir: diskdə saxlanan brend kataloqları/PNG-lər itər, mediapipe da limitə sığmır.
Uzunömürlü server + persistent disk lazımdır → Render (və ya Railway/Fly.io).

1. Kodu GitHub-a push et.
2. render.com → New → Blueprint → repo seç (`render.yaml` avtomatik oxunur).
3. Dashboard-da `ADMIN_PASSWORD` və (3D üçün) `DEEPAR_LICENSE_KEY` təyin et.
4. Custom domain bağla (Render HTTPS-i avtomatik verir).

`Dockerfile` lokal yoxlama üçün: `docker build -t tryon-wa . && docker run -p 8000:8000 -e ADMIN_PASSWORD=test tryon-wa`

## Backlog (Faza 3+ — indi yox, amma unutma)

- **Widget whitelist-i gücləndir**: Referer yoxlaması pilot üçün kifayətdir, amma Referer
  silinə/saxtalaşdırıla bilər. Pullu müştərilərdə → `Origin` header + hər brendin `embed_key`-i
  (artıq `brands.json`-da yaradılır, hələ yoxlanmır) widget script-ə parametr kimi əlavə olunsun.
- **DeepAR-a keçiddə kommersiya sualı**: DeepAR lisenziya açarı adətən bir domenə/layihəyə bağlıdır,
  bizim modeldə isə widget onlarla brend domenində işləyir. İlk "premium engine" istəyən brend
  gələndə DeepAR-dan birbaşa soruş: *"bir hesab/açar altında neçə fərqli domen/tenant dəstəklənir?"*
  Texniki keçid adapter sayəsində asandır — məsələ yalnız qiymət/şərtdir.
- Billing (Stripe və ya yerli ödəniş), brend-səviyyəli login (hər brend öz panelini görsün).

## Merchant kodu

```html
<script src="http://127.0.0.1:8000/vto-widget.js" data-store-id="demo"></script>
<button class="try-on-btn" data-sku="round-black">Virtual sına</button>
```

Canlı saytda `https` + öz domen. WooCommerce/Shopify plugin wrapper növbəti addımdır, eyni widget-i sarınır.
