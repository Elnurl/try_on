import FittingboxVTO from "@/components/FittingboxVTO";

const FRAME_ID =
  process.env.NEXT_PUBLIC_FITTINGBOX_FRAME_ID ?? "00192950009483";

export default function VtoTestPage() {
  return (
    <main className="min-h-[100dvh] w-full bg-zinc-50 px-4 py-10">
      <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          Eyewear VTO Test
        </h1>

        <article className="mt-8 w-full rounded-3xl bg-white p-6 shadow-sm ring-1 ring-zinc-200">
          <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Demo Eyewear
          </p>

          <div className="mt-5 flex aspect-[4/3] w-full items-center justify-center rounded-2xl bg-zinc-100">
            <svg
              viewBox="0 0 240 96"
              className="h-24 w-56 text-zinc-800"
              aria-hidden="true"
            >
              <g
                fill="none"
                stroke="currentColor"
                strokeWidth="6"
                strokeLinecap="round"
              >
                <rect x="12" y="22" width="84" height="52" rx="22" />
                <rect x="144" y="22" width="84" height="52" rx="22" />
                <path d="M96 46h48" />
                <path d="M12 42H4" />
                <path d="M228 42h8" />
              </g>
            </svg>
          </div>

          <h2 className="mt-5 text-xl font-semibold text-zinc-900">Demo Frame</h2>
          <p className="mt-1 text-sm text-zinc-500">Fittingbox</p>
          <p className="mt-2 font-mono text-xs text-zinc-400">{FRAME_ID}</p>

          <FittingboxVTO />
        </article>
      </div>
    </main>
  );
}
