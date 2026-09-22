import Link from "next/link";
import type { Metadata } from "next";
import { PRODUCTS } from "@/lib/products";
import ProductCard from "@/components/ProductCard";

export const metadata: Metadata = {
  title: "Kataloq",
};

export default function CatalogPage() {
  return (
    <main className="flex-1 px-4 py-10">
      <div className="mx-auto max-w-5xl">
        {/* Hero */}
        <section className="mb-10 rounded-3xl bg-zinc-900 px-8 py-12 text-white">
          <p className="text-sm font-medium uppercase tracking-widest text-zinc-400">
            Virtual Try-On
          </p>
          <h1 className="mt-2 text-3xl font-bold leading-tight sm:text-4xl">
            Eynəyi üzünüzdə görün —{" "}
            <span className="text-zinc-400">evdən çıxmadan.</span>
          </h1>
          <p className="mt-3 max-w-lg text-base text-zinc-400">
            Kameranız vasitəsilə istənilən çərçivəni real vaxtda sınayın. Satın
            almadan əvvəl.
          </p>
          <Link
            href="#catalog"
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-100"
          >
            Kataloqa bax
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 8.25l-7.5 7.5-7.5-7.5"
              />
            </svg>
          </Link>
        </section>

        {/* Catalog */}
        <section id="catalog">
          <h2 className="mb-6 text-xl font-semibold text-zinc-900">
            Məhsullar
          </h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {PRODUCTS.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </section>

        {/* VTO promo */}
        <section className="mt-12 rounded-2xl border border-zinc-200 bg-white px-6 py-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100">
            <svg
              className="h-6 w-6 text-zinc-700"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z"
              />
            </svg>
          </div>
          <h3 className="mt-4 text-lg font-semibold text-zinc-900">
            Virtual Try-On necə işləyir?
          </h3>
          <p className="mt-2 text-sm text-zinc-500">
            Məhsulun üzərinə klikləyin → <strong>Üzümdə yoxla</strong> düyməsini
            basın → kameraya icazə verin → eynəyi üzünüzdə görün.
          </p>
        </section>
      </div>
    </main>
  );
}
