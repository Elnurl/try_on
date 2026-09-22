import Link from "next/link";
import type { Product } from "@/lib/products";

type Props = {
  product: Product;
};

export default function ProductCard({ product }: Props) {
  return (
    <Link
      href={`/product/${product.id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white transition hover:border-zinc-300 hover:shadow-md"
    >
      {/* Image placeholder */}
      <div className="relative flex aspect-[4/3] w-full items-center justify-center bg-zinc-100">
        <EyewearIcon />
        <span className="absolute right-3 top-3 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 shadow-sm">
          {product.category}
        </span>
      </div>

      {/* Info */}
      <div className="flex flex-1 flex-col px-4 py-4">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          {product.brand}
        </p>
        <h2 className="mt-1 text-base font-semibold text-zinc-900 group-hover:text-zinc-700">
          {product.name}
        </h2>

        {/* Colors */}
        <div className="mt-2 flex gap-1.5">
          {product.colors.map((c) => (
            <span
              key={c.name}
              className="h-4 w-4 rounded-full border border-zinc-300"
              style={{ backgroundColor: c.hex }}
              title={c.name}
            />
          ))}
        </div>

        <div className="mt-auto flex items-center justify-between pt-3">
          <span className="text-base font-semibold text-zinc-900">
            {product.price} {product.currency}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600">
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"
              />
            </svg>
            VTO
          </span>
        </div>
      </div>
    </Link>
  );
}

function EyewearIcon() {
  return (
    <svg
      viewBox="0 0 240 96"
      className="h-20 w-48 text-zinc-700"
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
  );
}
