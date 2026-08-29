/**
 * White-label no-code widget.
 * Merchant adds one script + buttons: <button class="try-on-btn" data-sku="...">
 * Opens a modal iframe so MediaPipe/WASM never loads on the merchant origin.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var origin = new URL(script.src).origin;
  var storeId = script.getAttribute("data-store-id") || "demo";

  var css = [
    "#vto-modal{position:fixed;inset:0;z-index:2147483646;background:rgba(20,17,14,.55);display:flex;align-items:center;justify-content:center;padding:16px}",
    "#vto-modal[hidden]{display:none}",
    "#vto-sheet{position:relative;width:min(1100px,96vw);height:min(720px,94vh);background:#111;border-radius:4px;overflow:hidden}",
    "#vto-sheet iframe{width:100%;height:100%;border:0}",
    "#vto-close{display:none}",
  ].join("");

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var modal = document.createElement("div");
  modal.id = "vto-modal";
  modal.hidden = true;
  modal.innerHTML =
    '<div id="vto-sheet"><button type="button" id="vto-close" aria-label="Bağla">×</button><iframe allow="camera; microphone" title="Virtual Try-On"></iframe></div>';
  function mount() {
    if (!document.body || document.getElementById("vto-modal")) return;
    document.body.appendChild(modal);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  var iframe = modal.querySelector("iframe");
  function close() {
    modal.hidden = true;
    iframe.src = "about:blank";
  }
  function open(sku) {
    iframe.src =
      origin +
      "/embed?brand=" +
      encodeURIComponent(storeId) +
      "&sku=" +
      encodeURIComponent(sku || "");
    modal.hidden = false;
  }

  modal.addEventListener("click", function (e) {
    if (e.target === modal) close();
  });
  modal.querySelector("#vto-close").addEventListener("click", close);
  window.addEventListener("message", function (e) {
    if (!e.data) return;
    if (e.data.type === "vto-close") close();
    if (e.data.type === "vto-add-to-cart") {
      if (e.data.buy_url) {
        window.location.href = e.data.buy_url;
        return;
      }
      close();
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modal.hidden) close();
  });
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".try-on-btn");
    if (!btn) return;
    e.preventDefault();
    open(btn.getAttribute("data-sku"));
  });
})();
