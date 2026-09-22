"use client";

import Link from "next/link";
import { useState } from "react";
import type { Product } from "@/lib/products";
import { useCart } from "@/lib/cart";
import FittingboxVTO from "./FittingboxVTO";

type Props = {
  product: Product;
};

export default function ProductDetail({ product }: Props) {
  const { add, items } = useCart();
  const [added, setAdded] = useState(false);
  const inCart = items.some((i) => i.product.id === product.id);

  function handleAdd() {
    add(product);
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  }

  return (
    <main className="flex-1 px-4 py-8">
      <div className="mx-auto max-w-5xl">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 text-sm text-zinc-500">
          <Link href="/" className="transition hover:text-zinc-900">
            Kataloq
          </Link>
          <span>/</span>
          <span className="text-zinc-900">{product.name}</span>
        </nav>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          {/* Left — image + VTO */}
          <div className="flex flex-col gap-4">
            {/* Product image */}
            <div className="flex aspect-square w-full items-center justify-center rounded-3xl bg-zinc-100">
              <svg
                viewBox="0 0 240 96"
                className="h-32 w-64 text-zinc-700"
                fill="none"
                stroke="currentColor"
                strokeWidth={5}
                strokeLinecap="round"
                aria-hidden="true"
              >
                <rect x="12" y="22" width="84" height="52" rx="22" />
                <rect x="144" y="22" width="84" height="52" rx="22" />
                <path d="M96 46h48" />
                <path d="M12 42H4" />
                <path d="M228 42h8" />
              </svg>
            </div>

            {/* VTO button area */}
            <FittingboxVTO frameId={product.frameId} />
          </div>

          {/* Right — info + add to cart */}
          <div className="flex flex-col">
            <p className="text-sm font-medium uppercase tracking-wide text-zinc-400">
              {product.brand}
            </p>
            <h1 className="mt-1 text-2xl font-bold text-zinc-900 sm:text-3xl">
              {product.name}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">{product.category}</p>

            {/* Price */}
            <p className="mt-4 text-3xl font-bold text-zinc-900">
              {product.price}{" "}
              <span className="text-xl font-medium">{product.currency}</span>
            </p>

            {/* Colors */}
            {product.colors.length > 1 && (
              <div className="mt-4">
                <p className="mb-2 text-sm font-medium text-zinc-700">Rəng</p>
                <div className="flex gap-2">
                  {product.colors.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      title={c.name}
                      className="h-7 w-7 rounded-full border-2 border-white ring-2 ring-zinc-300"
                      style={{ backgroundColor: c.hex }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Description */}
            <p className="mt-5 text-sm leading-relaxed text-zinc-600">
              {product.description}
            </p>

            {/* Features */}
            <ul className="mt-4 flex flex-wrap gap-2">
              {product.features.map((f) => (
                <li
                  key={f}
                  className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-600"
                >
                  {f}
                </li>
              ))}
            </ul>

            {/* Add to cart */}
            <div className="mt-8 flex flex-col gap-3">
              <button
                type="button"
                onClick={handleAdd}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-zinc-900 px-6 py-3.5 text-base font-semibold text-white transition hover:bg-zinc-700 active:scale-[0.98]"
              >
                {added ? (
                  <>
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4.5 12.75l6 6 9-13.5"
                      />
                    </svg>
                    Səbətə əlavə edildi
                  </>
                ) : inCart ? (
                  "Yenidən əlavə et"
                ) : (
                  "Səbətə əlavə et"
                )}
              </button>

              {inCart && (
                <Link
                  href="/cart"
                  className="flex w-full items-center justify-center gap-2 rounded-full border border-zinc-300 px-6 py-3 text-sm font-semibold text-zinc-700 transition hover:border-zinc-500"
                >
                  Səbətə bax →
                </Link>
              )}
            </div>

            {/* Trust signals */}
            <div className="mt-8 grid grid-cols-3 gap-3 border-t border-zinc-200 pt-6">
              {[
                { icon: "🔄", label: "30 gün\ngeri qaytarma" },
                { icon: "🚚", label: "Pulsuz\nçatdırılma" },
                { icon: "✅", label: "Orijinal\nmarka" },
              ].map((item) => (
                <div key={item.label} className="text-center">
                  <div className="text-2xl">{item.icon}</div>
                  <p className="mt-1 whitespace-pre-line text-xs text-zinc-500">
                    {item.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
