"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
} from "react";
import type { Product } from "./products";

export type CartItem = {
  product: Product;
  quantity: number;
};

type CartState = {
  items: CartItem[];
};

type CartAction =
  | { type: "ADD"; product: Product }
  | { type: "REMOVE"; productId: string }
  | { type: "CLEAR" };

function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "ADD": {
      const existing = state.items.find(
        (i) => i.product.id === action.product.id,
      );
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.product.id === action.product.id
              ? { ...i, quantity: i.quantity + 1 }
              : i,
          ),
        };
      }
      return { items: [...state.items, { product: action.product, quantity: 1 }] };
    }
    case "REMOVE":
      return {
        items: state.items.filter((i) => i.product.id !== action.productId),
      };
    case "CLEAR":
      return { items: [] };
  }
}

type CartContextValue = {
  items: CartItem[];
  totalCount: number;
  totalPrice: number;
  add: (product: Product) => void;
  remove: (productId: string) => void;
  clear: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, { items: [] });

  const add = useCallback(
    (product: Product) => dispatch({ type: "ADD", product }),
    [],
  );
  const remove = useCallback(
    (productId: string) => dispatch({ type: "REMOVE", productId }),
    [],
  );
  const clear = useCallback(() => dispatch({ type: "CLEAR" }), []);

  const totalCount = useMemo(
    () => state.items.reduce((s, i) => s + i.quantity, 0),
    [state.items],
  );
  const totalPrice = useMemo(
    () =>
      state.items.reduce((s, i) => s + i.product.price * i.quantity, 0),
    [state.items],
  );

  const value = useMemo(
    () => ({ items: state.items, totalCount, totalPrice, add, remove, clear }),
    [state.items, totalCount, totalPrice, add, remove, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}
