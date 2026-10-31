/**
 * Eynek VTO SDK — one script tag for any website.
 *
 *   <script src="https://VTO_HOST/sdk/eynek-vto.js" data-store="STORE_ID" async></script>
 *
 *   <button data-eynek-vto="SKU">Üzündə yoxla</button>          declarative button
 *   <eynek-vto variant-id="SKU"></eynek-vto>  el.open()          TINT-compatible element
 *   EynekVTO.open({ sku })  EynekVTO.isAvailable(sku)  EynekVTO.on("add-to-cart", fn)
 *
 *   EynekVTO.open({
 *     sku, lang: "az" | "ru" | "en",
 *     product:  { name, price, currency, vendor, image, available },   shown in the window
 *     products: [{ sku, name, price, vendor, image, available }],      "similar models" strip
 *     onAddToCart(detail) → optional { ok: false, message } to report a failure
 *     onViewCart(detail), termsUrl, termsVersion, cart: false
 *   })
 *
 * The try-on runs in an iframe on the VTO origin, so camera/WASM never touch the host page.
 */
(function () {
  if (window.EynekVTO) return;
  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : location.origin;
  var defaultStore = (script && (script.getAttribute("data-store") || script.getAttribute("data-store-id"))) || "";
  var listeners = {};
  var availability = {};
  var modal = null;
  var frame = null;
  var current = null;
  var prevOverflow = "";

  function emit(type, detail) {
    (listeners[type] || []).forEach(function (fn) {
      try {
        fn(detail);
      } catch (e) {
        console.error(e);
      }
    });
    window.dispatchEvent(new CustomEvent("eynek-vto:" + type, { detail: detail }));
  }

  function ensureModal() {
    if (modal) return;
    var style = document.createElement("style");
    style.textContent =
      ".evto-modal{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(17,18,20,.48);animation:evto-fade .2s ease both}" +
      ".evto-modal[hidden]{display:none}" +
      ".evto-sheet{position:relative;width:min(1120px,100%);height:min(760px,90vh);height:min(760px,90dvh);border-radius:20px;overflow:hidden;background:#f3f3f1;box-shadow:0 24px 60px rgba(17,18,20,.22)}" +
      ".evto-sheet iframe{display:block;width:100%;height:100%;border:0}" +
      "@keyframes evto-fade{from{opacity:0}}" +
      "@media (max-width:640px){.evto-modal{padding:0}.evto-sheet{width:100vw;height:100%;border-radius:0}}";
    document.head.appendChild(style);
    modal = document.createElement("div");
    modal.className = "evto-modal";
    modal.hidden = true;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = '<div class="evto-sheet"><iframe title="Virtual sınaq" allow="camera; fullscreen; clipboard-write"></iframe></div>';
    frame = modal.querySelector("iframe");
    modal.addEventListener("click", function (e) {
      if (e.target === modal) close();
    });
    document.body.appendChild(modal);
  }

  function open(opts) {
    opts = typeof opts === "string" ? { sku: opts } : opts || {};
    var store = opts.store || defaultStore;
    if (!store) throw new Error("EynekVTO: data-store və ya open({ store }) lazımdır");
    ensureModal();
    var sku = opts.sku != null ? String(opts.sku) : opts.product && opts.product.sku != null ? String(opts.product.sku) : "";
    var lang = opts.lang || document.documentElement.lang || "az";
    current = {
      store: store,
      sku: sku,
      onAddToCart: opts.onAddToCart,
      onViewCart: opts.onViewCart,
      config: {
        lang: lang,
        product: opts.product ? Object.assign({}, opts.product, { sku: sku }) : sku ? { sku: sku } : null,
        products: opts.products || null,
        cart: opts.cart !== false,
        viewCart: opts.viewCart !== false,
        termsUrl: opts.termsUrl || null,
        termsVersion: opts.termsVersion || null,
        termsPoints: opts.termsPoints || null,
      },
    };
    var url = origin + "/embed?store=" + encodeURIComponent(store) + "&sku=" + encodeURIComponent(sku) + "&lang=" + encodeURIComponent(lang);
    if (opts.cart === false) url += "&cart=0";
    frame.src = url;
    modal.hidden = false;
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    emit("open", current);
  }

  function close() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    frame.src = "about:blank";
    document.documentElement.style.overflow = prevOverflow;
    emit("close", current);
  }

  function isAvailable(sku, store) {
    store = store || defaultStore;
    var key = store + "/" + sku;
    if (!availability[key]) {
      availability[key] = fetch(origin + "/v1/stores/" + encodeURIComponent(store) + "/products/" + encodeURIComponent(sku))
        .then(function (r) {
          return r.ok;
        })
        .catch(function () {
          return false;
        });
    }
    return availability[key];
  }

  function products(store) {
    return fetch(origin + "/v1/stores/" + encodeURIComponent(store || defaultStore) + "/products").then(function (r) {
      return r.ok ? r.json().then(function (d) { return d.products; }) : [];
    });
  }

  function reply(message) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(Object.assign({ source: "eynek-vto-host" }, message), origin);
  }

  function addToCart(detail) {
    var handlers = (listeners["add-to-cart"] || []).slice();
    if (current && current.onAddToCart) handlers.unshift(current.onAddToCart);
    var results = handlers.map(function (fn) {
      try {
        return Promise.resolve(fn(detail));
      } catch (err) {
        return Promise.resolve({ ok: false, message: err && err.message });
      }
    });
    window.dispatchEvent(new CustomEvent("eynek-vto:add-to-cart", { detail: detail }));
    Promise.all(results).then(function (values) {
      var failed = values.filter(function (v) {
        return v === false || (v && v.ok === false);
      })[0];
      reply({ type: "cart-result", ok: !failed, message: failed && failed.message });
    });
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || e.data.source !== "eynek-vto") return;
    if (!frame || e.source !== frame.contentWindow) return;
    var d = e.data;
    var detail = { store: d.store, sku: d.sku, product: d.product, image: d.image, message: d.message, code: d.code };
    if (d.type === "hello") reply({ type: "init", config: current ? current.config : {} });
    else if (d.type === "close") close();
    else if (d.type === "add-to-cart") addToCart(detail);
    else if (d.type === "view-cart") {
      if (current && current.onViewCart) current.onViewCart(detail);
      emit("view-cart", detail);
      close();
    } else emit(d.type, detail);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-eynek-vto], .try-on-btn[data-sku]");
    if (!btn || btn.tagName === "EYNEK-VTO") return;
    e.preventDefault();
    open({
      sku: btn.getAttribute("data-eynek-vto") || btn.getAttribute("data-sku"),
      store: btn.getAttribute("data-store") || undefined,
      cart: btn.getAttribute("data-eynek-cart") !== "0",
    });
  });

  function autoHide() {
    var nodes = document.querySelectorAll("[data-eynek-vto][data-eynek-hide-missing]");
    Array.prototype.forEach.call(nodes, function (node) {
      if (node.__evtoChecked) return;
      node.__evtoChecked = true;
      node.hidden = true;
      isAvailable(node.getAttribute("data-eynek-vto"), node.getAttribute("data-store")).then(function (ok) {
        node.hidden = !ok;
      });
    });
  }

  if (window.customElements && !customElements.get("eynek-vto")) {
    customElements.define(
      "eynek-vto",
      class extends HTMLElement {
        configure(opts) {
          this._opts = opts || {};
        }
        open(extra) {
          open(
            Object.assign({}, this._opts, extra, {
              sku: (extra && extra.sku) || this.getAttribute("variant-id") || this.getAttribute("sku") || "",
              store: this.getAttribute("store") || (this._opts && this._opts.store) || undefined,
            }),
          );
        }
        close() {
          close();
        }
      }
    );
  }

  window.EynekVTO = { open: open, close: close, isAvailable: isAvailable, products: products, on: function (type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
  }, origin: origin };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoHide);
  else autoHide();
  if (window.MutationObserver) new MutationObserver(autoHide).observe(document.documentElement, { childList: true, subtree: true });
})();
