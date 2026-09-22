"use client";

import Link from "next/link";
import { useCart } from "@/lib/cart";

export default function CartPage() {
  const { items, totalCount, totalPrice, remove, clear } = useCart();

  if (items.length === 0) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-zinc-100">
          <svg
            className="h-10 w-10 text-zinc-400"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"
            />
          </svg>
        </div>
        <h1 className="mt-5 text-xl font-semibold text-zinc-900">
          Səbət boşdur
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          Bəyəndiyiniz eynəyi kataloqdan əlavə edin.
        </p>
        <Link
          href="/"
          className="mt-6 rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-zinc-700"
        >
          Kataloqa bax
        </Link>
      </main>
    );
  }

  return (
    <main className="flex-1 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-zinc-900">
            Səbət{" "}
            <span className="text-base font-normal text-zinc-500">
              ({totalCount} məhsul)
            </span>
          </h1>
          <button
            type="button"
            onClick={clear}
            className="text-sm text-zinc-400 underline transition hover:text-zinc-700"
          >
            Təmizlə
          </button>
        </div>

        {/* Items */}
        <ul className="flex flex-col gap-3">
          {items.map(({ product, quantity }) => (
            <li
              key={product.id}
              className="flex items-center gap-4 rounded-2xl border border-zinc-200 bg-white px-4 py-4"
            >
              {/* Thumb */}
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-zinc-100">
                <svg
                  viewBox="0 0 240 96"
                  className="h-8 w-16 text-zinc-600"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={7}
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <rect x="12" y="22" width="84" height="52" rx="22" />
                  <rect x="144" y="22" width="84" height="52" rx="22" />
                  <path d="M96 46h48" />
                </svg>
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-zinc-400">{product.brand}</p>
                <p className="truncate font-semibold text-zinc-900">
                  {product.name}
                </p>
                <p className="mt-0.5 text-sm text-zinc-500">
                  {quantity} × {product.price} {product.currency}
                </p>
              </div>

              {/* Subtotal + remove */}
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className="font-semibold text-zinc-900">
                  {product.price * quantity} {product.currency}
                </span>
                <button
                  type="button"
                  onClick={() => remove(product.id)}
                  className="text-xs text-zinc-400 underline transition hover:text-red-500"
                >
                  Sil
                </button>
              </div>
            </li>
          ))}
        </ul>

        {/* Summary */}
        <div className="mt-6 rounded-2xl border border-zinc-200 bg-white px-5 py-5">
          <div className="flex justify-between text-sm text-zinc-600">
            <span>Çatdırılma</span>
            <span className="font-medium text-green-600">Pulsuz</span>
          </div>
          <div className="mt-2 flex justify-between border-t border-zinc-200 pt-3 text-base font-bold text-zinc-900">
            <span>Cəmi</span>
            <span>{totalPrice} AZN</span>
          </div>

          <button
            type="button"
            className="mt-5 w-full rounded-full bg-zinc-900 py-3.5 text-base font-semibold text-white transition hover:bg-zinc-700"
            onClick={() => alert("Ödəniş modulu tezliklə əlavə olunacaq.")}
          >
            Sifarişi rəsmiləşdir
          </button>

          <Link
            href="/"
            className="mt-3 flex w-full items-center justify-center text-sm text-zinc-500 underline"
          >
            Alışverişə davam et
          </Link>
        </div>
      </div>
    </main>
  );
}
