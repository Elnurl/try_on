(() => {
  const CART_KEY = "glassify-cart";

  function loadCart() {
    try {
      const raw = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function saveCart(items) {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
    updateBadge();
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

  function updateBadge() {
    const el = document.querySelector("[data-cart-count]");
    if (!el) return;
    const n = totalCount(loadCart());
    el.textContent = String(n);
    el.classList.toggle("is-on", n > 0);
    el.closest("a")?.setAttribute(
      "aria-label",
      n > 0 ? `Səbət, ${n} məhsul` : "Səbət",
    );
  }

  function addProduct(product) {
    const items = loadCart();
    const existing = items.find((row) => row.product.id === product.id);
    if (existing) existing.quantity += 1;
    else items.push({ product, quantity: 1 });
    saveCart(items);
    return items;
  }

  function removeProduct(productId) {
    saveCart(loadCart().filter((row) => row.product.id !== productId));
  }

  function glassesSvg(cls) {
    return `<svg viewBox="0 0 240 96" class="${cls}" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" aria-hidden="true">
      <rect x="12" y="22" width="84" height="52" rx="22"></rect>
      <rect x="144" y="22" width="84" height="52" rx="22"></rect>
      <path d="M96 46h48"></path>
      <path d="M12 42H4"></path>
      <path d="M228 42h8"></path>
    </svg>`;
  }

  function renderCartPage() {
    const root = document.querySelector("[data-cart-root]");
    if (!root) return;
    const items = loadCart();
    if (!items.length) {
      root.innerHTML = `
        <div class="g-empty">
          <h1>Səbət boşdur</h1>
          <p class="g-hint">Bəyəndiyiniz eynəyi kataloqdan əlavə edin.</p>
          <a class="g-btn" href="/shop" style="max-width:220px;margin:24px auto 0">Kataloqa bax</a>
        </div>`;
      return;
    }
    const rows = items
      .map(
        ({ product, quantity }) => `
        <li class="g-item">
          <div class="g-item-art">${glassesSvg("g-icon")}</div>
          <div style="flex:1;min-width:0">
            <p class="g-brand">${escapeHtml(product.brand)}</p>
            <h2>${escapeHtml(product.name)}</h2>
            <p>${quantity} × ${product.price} ${escapeHtml(product.currency)}</p>
          </div>
          <div style="text-align:right">
            <strong>${product.price * quantity} ${escapeHtml(product.currency)}</strong>
            <div><button type="button" data-remove="${escapeHtml(product.id)}">Sil</button></div>
          </div>
        </li>`,
      )
      .join("");
    root.innerHTML = `
      <div class="g-cart">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
          <h1>Səbət <span style="font-size:16px;font-weight:400;color:#71717a">(${totalCount(items)} məhsul)</span></h1>
          <button type="button" data-clear style="border:0;padding:0;background:none;text-decoration:underline;color:#a1a1aa;cursor:pointer">Təmizlə</button>
        </div>
        <ul style="list-style:none;margin:0;padding:0">${rows}</ul>
        <div class="g-sum">
          <div class="g-sum-row"><span>Çatdırılma</span><span style="color:#16a34a;font-weight:500">Pulsuz</span></div>
          <div class="g-sum-row total"><span>Cəmi</span><span>${totalPrice(items)} AZN</span></div>
          <button type="button" class="g-btn" data-checkout>Sifarişi rəsmiləşdir</button>
          <a href="/shop" style="display:block;margin-top:12px;text-align:center;color:#71717a;font-size:14px;text-decoration:underline">Alışverişə davam et</a>
        </div>
      </div>`;
    root.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        removeProduct(btn.getAttribute("data-remove"));
        renderCartPage();
      });
    });
    root.querySelector("[data-clear]")?.addEventListener("click", () => {
      saveCart([]);
      renderCartPage();
    });
    root.querySelector("[data-checkout]")?.addEventListener("click", () => {
      window.alert("Ödəniş modulu tezliklə əlavə olunacaq.");
    });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function wireProductCart() {
    const btn = document.querySelector("[data-add-cart]");
    if (!btn || !window.SHOP_PRODUCT) return;
    const product = window.SHOP_PRODUCT;
    const view = document.querySelector("[data-view-cart]");
    const inCart = () => loadCart().some((row) => row.product.id === product.id);
    const paint = () => {
      if (inCart()) {
        btn.textContent = "Yenidən əlavə et";
        if (view) view.hidden = false;
      }
    };
    paint();
    btn.addEventListener("click", () => {
      addProduct(product);
      btn.textContent = "Səbətə əlavə edildi";
      if (view) view.hidden = false;
      window.setTimeout(paint, 2000);
    });
  }

  updateBadge();
  renderCartPage();
  wireProductCart();
})();
