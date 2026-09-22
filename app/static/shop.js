(() => {
  const CART_KEY = "eynek-cart";
  const SAVED_KEY = "eynek-saved";
  const LEGACY_CART_KEY = "glassify-cart";
  const LEGACY_SAVED_KEY = "glassify-saved";

  (function migrateLegacyKeys() {
    try {
      if (!localStorage.getItem(CART_KEY) && localStorage.getItem(LEGACY_CART_KEY)) {
        localStorage.setItem(CART_KEY, localStorage.getItem(LEGACY_CART_KEY));
      }
      if (!localStorage.getItem(SAVED_KEY) && localStorage.getItem(LEGACY_SAVED_KEY)) {
        localStorage.setItem(SAVED_KEY, localStorage.getItem(LEGACY_SAVED_KEY));
      }
    } catch {
      /* ignore */
    }
  })();

  const GLASSES_SVG = `<svg viewBox="0 0 240 96" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" aria-hidden="true">
    <rect x="12" y="22" width="84" height="52" rx="22"></rect>
    <rect x="144" y="22" width="84" height="52" rx="22"></rect>
    <path d="M96 46h48"></path>
    <path d="M12 42H4"></path>
    <path d="M228 42h8"></path>
  </svg>`;

  function loadJson(key, fallback) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "null");
      return raw == null ? fallback : raw;
    } catch {
      return fallback;
    }
  }

  function loadCart() {
    const raw = loadJson(CART_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (row) =>
        row &&
        row.product &&
        typeof row.product === "object" &&
        row.product.id &&
        Number(row.quantity) > 0,
    );
  }

  function saveCart(items) {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
    updateBadge();
  }

  function loadSaved() {
    const raw = loadJson(SAVED_KEY, []);
    return Array.isArray(raw) ? raw.map(String) : [];
  }

  function saveSaved(ids) {
    localStorage.setItem(SAVED_KEY, JSON.stringify(ids));
  }

  function totalCount(items) {
    return items.reduce((sum, row) => sum + (row.quantity || 0), 0);
  }

  function totalPrice(items) {
    return items.reduce(
      (sum, row) => sum + (row.product.price || 0) * (row.quantity || 0),
      0,
    );
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function toast(message) {
    const el = document.querySelector("[data-toast]");
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    el.classList.add("is-on");
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => el.classList.remove("is-on"), 1800);
  }

  function updateBadge() {
    document.querySelectorAll("[data-cart-count]").forEach((el) => {
      const n = totalCount(loadCart());
      el.textContent = String(n);
      el.classList.toggle("is-on", n > 0);
    });
  }

  function addProduct(product, qty = 1) {
    if (!product || !product.id) return loadCart();
    const amount = Math.max(1, Number(qty) || 1);
    const items = loadCart();
    const existing = items.find((row) => row.product.id === product.id);
    if (existing) existing.quantity += amount;
    else items.push({ product, quantity: amount });
    saveCart(items);
    return items;
  }

  function removeProduct(productId) {
    saveCart(loadCart().filter((row) => row.product.id !== productId));
  }

  function isSaved(id) {
    return loadSaved().includes(String(id));
  }

  function toggleSaved(id) {
    const key = String(id);
    const ids = loadSaved();
    const next = ids.includes(key)
      ? ids.filter((item) => item !== key)
      : [...ids, key];
    saveSaved(next);
    return next.includes(key);
  }

  function paintHearts(root = document) {
    root.querySelectorAll("[data-save]").forEach((btn) => {
      const on = isSaved(btn.getAttribute("data-save"));
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const productBtn = document.querySelector("[data-save-product]");
    if (productBtn && window.SHOP_PRODUCT) {
      const on = isSaved(window.SHOP_PRODUCT.id);
      productBtn.classList.toggle("is-on", on);
      productBtn.style.color = on ? "#e11d48" : "";
    }
  }

  function cardHtml(product) {
    const pid = escapeHtml(product.id);
    const filt = escapeHtml(product.filter || "sunglasses");
    const sellerId = escapeHtml(product.seller_id || "");
    const seller = escapeHtml(product.seller_name || "");
    const search = escapeHtml(
      `${product.brand} ${product.name} ${product.category} ${product.seller_name || ""}`.toLowerCase(),
    );
    const tryon = product.tryon
      ? '<span class="g-tryon-badge">3D SINAQ</span>'
      : "";
    const rating = product.rating != null ? Number(product.rating).toFixed(1) : "";
    const sellerMeta = seller
      ? `<p class="g-seller-meta">${seller}${rating ? ` <span class="star">★</span> ${rating}` : ""}</p>`
      : "";
    const media = product.image
      ? `<img class="g-card-photo" src="${escapeHtml(product.image)}" alt="" loading="lazy" />`
      : GLASSES_SVG;
    return `<article class="g-card" data-product-id="${pid}" data-filter="${filt}" data-seller="${sellerId}" data-search="${search}">
      <div class="g-card-art">
        <button type="button" class="g-heart" data-save="${pid}" aria-label="${escapeHtml(product.name)} saxla">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
        </button>
        ${tryon}
        <a href="/product/${pid}" aria-label="${escapeHtml(product.brand)} ${escapeHtml(product.name)}">${media}</a>
      </div>
      <a class="g-card-body" href="/product/${pid}">
        <p class="g-brand">${escapeHtml(product.brand)}</p>
        <h3>${escapeHtml(product.name)}</h3>
        <p class="g-price">${product.price} ${escapeHtml(product.currency)}</p>
        ${sellerMeta}
      </a>
    </article>`;
  }

  function wireSaveButtons(root = document) {
    root.querySelectorAll("[data-save]").forEach((btn) => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const on = toggleSaved(btn.getAttribute("data-save"));
        paintHearts();
        toast(on ? "Saxlanılanlara əlavə olundu" : "Saxlanılanlardan çıxarıldı");
        renderSavedGrid();
      });
    });
  }

  function applyCatalogFilter() {
    const filter =
      document.querySelector(".g-quick-chip.is-on")?.getAttribute("data-filter") ||
      document.querySelector(".g-filters:not(.g-filters-sellers) .g-chip.is-on")
        ?.getAttribute("data-filter") ||
      document.querySelector("[data-filter].is-on")?.getAttribute("data-filter") ||
      "all";
    const seller =
      document
        .querySelector("[data-seller-filter].is-on")
        ?.getAttribute("data-seller-filter") || "all";
    const query = (
      document.querySelector("[data-search-input]")?.value ||
      document.querySelector("[data-search-input-focus]")?.value ||
      ""
    )
      .trim()
      .toLowerCase();
    const cards = [...document.querySelectorAll("[data-product-grid] .g-card")];
    let visible = 0;
    cards.forEach((card) => {
      const matchFilter =
        filter === "all" || card.getAttribute("data-filter") === filter;
      const matchSeller =
        seller === "all" || card.getAttribute("data-seller") === seller;
      const hay = card.getAttribute("data-search") || "";
      const show =
        matchFilter && matchSeller && (!query || hay.includes(query));
      card.hidden = !show;
      if (show) visible += 1;
    });
    const grid = document.querySelector("[data-product-grid]");
    if (!grid) return;
    let empty = grid.querySelector(".g-empty-filter");
    if (!visible) {
      if (!empty) {
        empty = document.createElement("p");
        empty.className = "g-empty-filter";
        empty.textContent = "Bu filtrə uyğun məhsul yoxdur.";
        grid.appendChild(empty);
      }
    } else if (empty) {
      empty.remove();
    }
    const count = document.querySelector("[data-style-count]");
    if (count) count.textContent = `${visible} stil`;
  }

  function renderSavedGrid() {
    const grid = document.querySelector("[data-saved-grid]");
    if (!grid) return;
    const products = Array.isArray(window.SHOP_PRODUCTS)
      ? window.SHOP_PRODUCTS
      : [];
    const ids = new Set(loadSaved());
    const matched = products.filter((product) => ids.has(String(product.id)));
    if (!matched.length) {
      grid.innerHTML =
        '<p class="g-panel-empty">Hələ saxlanılan çərçivə yoxdur. Ürəyə toxunun.</p>';
      return;
    }
    grid.innerHTML = matched.map(cardHtml).join("");
    paintHearts(grid);
    wireSaveButtons(grid);
  }

  function showView(name) {
    document.querySelectorAll("[data-view]").forEach((view) => {
      view.hidden = view.getAttribute("data-view") !== name;
    });
    if (name === "saved") renderSavedGrid();
    if (name === "discover") {
      history.replaceState(null, "", "/shop");
    } else {
      history.replaceState(null, "", `/shop#${name}`);
    }
  }

  function wireHome() {
    if (!document.querySelector("[data-product-grid]")) return;

    document.querySelector("[data-menu-toggle]")?.addEventListener("click", () => {
      document.querySelector("[data-mobile-nav]")?.classList.toggle("is-open");
    });

    function setFilter(filter) {
      document.querySelectorAll("[data-filter]").forEach((item) => {
        item.classList.toggle("is-on", item.getAttribute("data-filter") === filter);
      });
      document.querySelectorAll(".g-quick-chip[data-filter]").forEach((item) => {
        item.classList.toggle("is-on", item.getAttribute("data-filter") === filter);
      });
      document.querySelectorAll("[data-nav-filter]").forEach((item) => {
        item.classList.toggle("is-on", item.getAttribute("data-nav-filter") === filter);
      });
      applyCatalogFilter();
      const catalog = document.querySelector("#catalog");
      if (catalog && filter !== "all") {
        catalog.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    document.querySelectorAll("[data-filter]").forEach((chip) => {
      chip.addEventListener("click", () => {
        setFilter(chip.getAttribute("data-filter") || "all");
      });
    });

    document.querySelectorAll("[data-nav-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setFilter(btn.getAttribute("data-nav-filter") || "all");
        document.querySelector("[data-mobile-nav]")?.classList.remove("is-open");
      });
    });

    document.querySelectorAll("[data-seller-filter]").forEach((chip) => {
      chip.addEventListener("click", () => {
        document
          .querySelectorAll("[data-seller-filter]")
          .forEach((item) => item.classList.remove("is-on"));
        chip.classList.add("is-on");
        applyCatalogFilter();
      });
    });

    const syncSearch = (value) => {
      document.querySelectorAll("[data-search-input], [data-search-input-focus]").forEach((input) => {
        if (input.value !== value) input.value = value;
      });
      applyCatalogFilter();
    };

    document.querySelectorAll("[data-search-input], [data-search-input-focus]").forEach((input) => {
      input.addEventListener("input", () => syncSearch(input.value));
    });

    document.querySelectorAll("[data-open-saved]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        showView("saved");
        document.querySelector("[data-mobile-nav]")?.classList.remove("is-open");
      });
    });

    document.querySelector("[data-back-discover]")?.addEventListener("click", () => {
      showView("discover");
    });

    wireSaveButtons();
    paintHearts();
    applyCatalogFilter();

    const hash = (location.hash || "").replace("#", "");
    if (hash === "saved") showView("saved");
  }

  function renderCartPage() {
    const root = document.querySelector("[data-cart-root]");
    if (!root) return;
    const items = loadCart();
    const clearBtn = document.querySelector("[data-clear-cart]");
    if (clearBtn) clearBtn.hidden = !items.length;
    if (!items.length) {
      root.innerHTML = `
        <div class="g-empty">
          <h1>Səbət boşdur</h1>
          <p>Bəyəndiyiniz eynəyi kataloqdan əlavə edin.</p>
          <a class="g-btn" href="/shop">Kataloqa bax</a>
        </div>`;
      return;
    }
    const rows = items
      .map(
        ({ product, quantity }) => `
        <li class="g-item">
          <div class="g-item-art">${
            product.image
              ? `<img src="${escapeHtml(product.image)}" alt="" width="72" height="48" />`
              : GLASSES_SVG
          }</div>
          <div>
            <p class="g-brand">${escapeHtml(product.brand)}</p>
            <h2>${escapeHtml(product.name)}</h2>
            <p>${quantity} × ${product.price} ${escapeHtml(product.currency || "AZN")}</p>
          </div>
          <div class="g-item-side">
            <strong>${product.price * quantity} ${escapeHtml(product.currency || "AZN")}</strong>
            <button type="button" class="remove" data-remove="${escapeHtml(product.id)}">Sil</button>
          </div>
        </li>`,
      )
      .join("");
    root.innerHTML = `
      <ul class="g-cart-list">${rows}</ul>
      <div class="g-sum">
        <div class="g-sum-row"><span>Çatdırılma</span><span class="g-sum-free">Pulsuz</span></div>
        <div class="g-sum-row total"><span>Cəmi</span><span>${totalPrice(items)} AZN</span></div>
        <form class="g-checkout" data-checkout-form>
          <h3>Sifariş məlumatları</h3>
          <label>Ad, soyad <input name="name" required autocomplete="name" placeholder="Elnur Əhmədzadə" /></label>
          <label>Telefon <input name="phone" type="tel" required autocomplete="tel" placeholder="+994 50 123 45 67" /></label>
          <label>Şəhər <input name="city" required autocomplete="address-level2" placeholder="Bakı" /></label>
          <label>Ünvan <input name="address" required autocomplete="street-address" placeholder="Küçə, bina, mənzil" /></label>
          <label>Qeyd (istəyə bağlı) <textarea name="note" rows="2" placeholder="Çatdırılma vaxtı və s."></textarea></label>
          <button type="submit" class="g-btn">Sifarişi göndər</button>
          <p class="g-checkout-note">Ödəniş nağd və ya kartla çatdırılmada. Təsdiq üçün sizinlə əlaqə saxlanılacaq.</p>
        </form>
      </div>`;
    root.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        removeProduct(btn.getAttribute("data-remove"));
        renderCartPage();
      });
    });
    root.querySelector("[data-checkout-form]")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const btn = form.querySelector('button[type="submit"]');
      const fd = new FormData(form);
      const cart = loadCart();
      if (!cart.length) {
        toast("Səbət boşdur");
        return;
      }
      const payload = {
        name: String(fd.get("name") || ""),
        phone: String(fd.get("phone") || ""),
        city: String(fd.get("city") || ""),
        address: String(fd.get("address") || ""),
        note: String(fd.get("note") || ""),
        items: cart.map(({ product, quantity }) => ({
          id: product.id,
          name: product.name,
          brand: product.brand,
          price: product.price,
          quantity,
          seller_id: product.seller_id || product.store_id || "",
          currency: product.currency || "AZN",
        })),
      };
      if (btn) btn.disabled = true;
      try {
        const res = await fetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast(data.detail || "Sifariş göndərilmədi");
          return;
        }
        saveCart([]);
        root.innerHTML = `
          <div class="g-empty g-order-ok">
            <h1>Sifariş qəbul olundu</h1>
            <p>Kod: <strong>${escapeHtml(data.id || "")}</strong>. Tezliklə sizinlə əlaqə saxlayacağıq.</p>
            <a class="g-btn" href="/shop">Kataloqa qayıt</a>
          </div>`;
        toast("Sifariş göndərildi");
      } catch {
        toast("Şəbəkə xətası");
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  function wireCartPage() {
    if (!document.querySelector("[data-cart-root]")) return;
    document.querySelector("[data-clear-cart]")?.addEventListener("click", () => {
      saveCart([]);
      renderCartPage();
      toast("Səbət təmizləndi");
    });
    renderCartPage();
  }

  function wireProductPage() {
    const product = window.SHOP_PRODUCT;
    if (!product) return;
    let qty = 1;
    const qtyEl = document.querySelector("[data-qty]");
    document.querySelector("[data-qty-minus]")?.addEventListener("click", () => {
      qty = Math.max(1, qty - 1);
      if (qtyEl) qtyEl.textContent = String(qty);
    });
    document.querySelector("[data-qty-plus]")?.addEventListener("click", () => {
      qty += 1;
      if (qtyEl) qtyEl.textContent = String(qty);
    });
    document.querySelectorAll("[data-size]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll("[data-size]")
          .forEach((item) => item.classList.remove("is-on"));
        btn.classList.add("is-on");
      });
    });
    document.querySelectorAll("[data-color]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll("[data-color]")
          .forEach((item) => item.classList.remove("is-on"));
        btn.classList.add("is-on");
      });
    });
    document.querySelector("[data-save-product]")?.addEventListener("click", () => {
      const on = toggleSaved(product.id);
      paintHearts();
      toast(on ? "Saxlanılanlara əlavə olundu" : "Saxlanılanlardan çıxarıldı");
    });
    document.querySelector("[data-add-cart]")?.addEventListener("click", () => {
      addProduct(product, qty);
      toast("Səbətə əlavə olundu");
    });
    document.querySelector("[data-buy-now]")?.addEventListener("click", () => {
      try {
        addProduct(product, qty);
      } catch (_) {
        /* continue to cart */
      }
    });
    paintHearts();
  }

  updateBadge();
  wireHome();
  wireCartPage();
  wireProductPage();
})();
