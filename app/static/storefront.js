const slug = document.body.dataset.slug;
const catalog = document.querySelector("#catalog");
const brandName = document.querySelector("#brand-name");
const heroTitle = document.querySelector("#hero-title");
const heroTag = document.querySelector("#hero-tag");
const cartLink = document.querySelector("#cart-link");

async function load() {
  const res = await fetch(`/api/brand/${slug}`);
  if (!res.ok) {
    catalog.innerHTML = "<p>Mağaza tapılmadı.</p>";
    return;
  }
  const data = await res.json();
  document.title = `${data.name} — eynəklər`;
  brandName.textContent = data.name;
  heroTitle.textContent = data.name;
  if (data.tagline) heroTag.textContent = data.tagline;
  if (data.accent) {
    document.documentElement.style.setProperty("--accent", data.accent);
  }
  const cart = (data.cart_url || "").trim();
  if (cart) {
    cartLink.hidden = false;
    cartLink.href = cart;
  }
  catalog.innerHTML = "";
  if (!data.frames.length) {
    catalog.innerHTML = "<p>Bu mağazada hələ eynək yoxdur.</p>";
    return;
  }
  data.frames.forEach((item) => {
    const card = document.createElement("article");
    card.className = "sku-card";
    card.innerHTML = `
      <img alt="" src="${item.image_url}" />
      <h2>${item.model || item.name}</h2>
      <p>${item.brand || data.name}</p>
      <a class="pill pill-dark" href="/t/${slug}?sku=${encodeURIComponent(item.id)}">Virtual sına</a>
    `;
    catalog.appendChild(card);
  });
}

load();
