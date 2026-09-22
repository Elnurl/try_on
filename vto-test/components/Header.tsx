"use client";

import Link from "next/link";
import { useCart } from "@/lib/cart";

export default function Header() {
  const { totalCount } = useCart();

  return (
    <header className="sticky top-0 z-40 w-full border-b border-zinc-200 bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-1.5 text-xl font-bold tracking-tight text-zinc-900"
        >
          <span className="text-zinc-900">Glassify</span>
          <span className="text-xs font-normal text-zinc-400">.az</span>
        </Link>

        {/* Nav */}
        <nav className="hidden gap-6 text-sm font-medium text-zinc-600 sm:flex">
          <Link href="/" className="transition hover:text-zinc-900">
            Kataloq
          </Link>
          <Link href="/about" className="transition hover:text-zinc-900">
            Haqqımızda
          </Link>
        </nav>

        {/* Cart */}
        <Link
          href="/cart"
          className="relative flex items-center gap-2 rounded-full border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:border-zinc-400 hover:text-zinc-900"
          aria-label={`Səbət${totalCount > 0 ? `, ${totalCount} məhsul` : ""}`}
        >
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
              d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"
            />
          </svg>
          <span className="hidden sm:inline">Səbət</span>
          {totalCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900 text-[10px] font-bold text-white">
              {totalCount}
            </span>
          )}
        </Link>
      </div>
    </header>
  );
}
