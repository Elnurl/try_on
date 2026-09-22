export default function Footer() {
  return (
    <footer className="mt-auto border-t border-zinc-200 bg-white py-8">
      <div className="mx-auto max-w-5xl px-4 text-center text-sm text-zinc-500">
        <p className="font-semibold text-zinc-900">Glassify.az</p>
        <p className="mt-1">
          Virtual Try-On texnologiyası ilə eynəyinizi evdən seçin.
        </p>
        <p className="mt-3 text-xs text-zinc-400">
          © {new Date().getFullYear()} Glassify. Bütün hüquqlar qorunur.
        </p>
      </div>
    </footer>
  );
}
