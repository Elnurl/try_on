import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { CartProvider } from "@/lib/cart";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Glassify.az — Virtual Try-On",
    template: "%s | Glassify.az",
  },
  description:
    "Azərbaycanın ilk virtual eynək sınağı platformu. Kameranız vasitəsilə eynəyi üzünüzdə görün.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="az"
      className={`${geistSans.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body
        className="flex min-h-full flex-col overflow-x-hidden bg-zinc-50 font-sans text-zinc-900"
        suppressHydrationWarning
      >
        <CartProvider>
          <Header />
          <div className="flex flex-1 flex-col">{children}</div>
          <Footer />
        </CartProvider>
      </body>
    </html>
  );
}
