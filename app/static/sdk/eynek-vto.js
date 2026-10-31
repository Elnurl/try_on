/**
 * Eynek VTO SDK — one script tag for any website.
 *
 *   <script src="https://VTO_HOST/sdk/eynek-vto.js" data-store="STORE_ID" async></script>
 *
 *   <button data-eynek-vto="SKU">Üzündə yoxla</button>          declarative button
 *   <eynek-vto variant-id="SKU"></eynek-vto>  el.open()          TINT-compatible element
 *   EynekVTO.open({ sku })  EynekVTO.isAvailable(sku)  EynekVTO.on("add-to-cart", fn)
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
      ".evto-modal{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(15,12,10,.6)}" +
      ".evto-modal[hidden]{display:none}" +
      ".evto-sheet{position:relative;width:min(980px,96vw);height:min(700px,92vh);border-radius:14px;overflow:hidden;background:#0e0d0c;box-shadow:0 20px 60px rgba(0,0,0,.4)}" +
      ".evto-sheet iframe{display:block;width:100%;height:100%;border:0}" +
      "@media (max-width:640px){.evto-sheet{width:100vw;height:100%;border-radius:0}}";
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
    current = { store: store, sku: opts.sku || "" };
    var url = origin + "/embed?store=" + encodeURIComponent(store) + "&sku=" + encodeURIComponent(current.sku);
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

  window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || e.data.source !== "eynek-vto") return;
    var d = e.data;
    if (d.type === "close") close();
    else emit(d.type, { store: d.store, sku: d.sku, image: d.image, message: d.message });
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
        open() {
          open({
            sku: this.getAttribute("variant-id") || this.getAttribute("sku") || "",
            store: this.getAttribute("store") || undefined,
          });
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
