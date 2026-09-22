export type Product = {
  id: string;
  name: string;
  brand: string;
  price: number;
  currency: string;
  frameId: string; // Fittingbox frame EAN
  colors: ProductColor[];
  category: string;
  description: string;
  features: string[];
};

export type ProductColor = {
  name: string;
  hex: string;
  frameId: string;
};

export const PRODUCTS: Product[] = [
  {
    id: "rb-aviator-classic",
    name: "Aviator Classic",
    brand: "Ray-Ban",
    price: 259,
    currency: "AZN",
    frameId: "00192950009483",
    category: "Günəş eynəyi",
    description:
      "Ray-Ban Aviator Classic — 1937-ci ildən gələn ikonik dizayn. Yüksək keyfiyyətli metal çərçivə və UV qoruyucu linzalar.",
    features: ["UV400 qoruma", "Metal çərçivə", "Unisex dizayn", "Klassik pilot forması"],
    colors: [
      { name: "Qızılı / Yaşıl", hex: "#b8960c", frameId: "00192950009483" },
    ],
  },
  {
    id: "rb-new-wayfarer",
    name: "New Wayfarer",
    brand: "Ray-Ban",
    price: 229,
    currency: "AZN",
    frameId: "00889652315713",
    category: "Günəş eynəyi",
    description:
      "Ray-Ban New Wayfarer — zamanın sınağından çıxmış ikonik forma. Yüngül plastik çərçivə, rahat taxınma.",
    features: ["UV400 qoruma", "Plastik çərçivə", "Unisex dizayn", "Klassik kvadrat forma"],
    colors: [
      { name: "Qara / Qara", hex: "#1a1a1a", frameId: "00889652315713" },
    ],
  },
];

export function getProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}
