import type { OrderLine, OrderMenuItem } from "./types";

export type Cart = Record<string, OrderLine>;
export type AddBlockReason = "stock" | "item_limit" | "order_limit";

export function lineTotal(line: Pick<OrderLine, "price" | "qty">) {
  return Number(line.price) * line.qty;
}

export function cartTotal(lines: OrderLine[]) {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}

export function cartItemCount(lines: Pick<OrderLine, "qty">[]) {
  return lines.reduce((sum, line) => sum + line.qty, 0);
}

/** Pezzi ancora aggiungibili di un prodotto; null significa scorte illimitate. */
export function remainingStock(cart: Cart, item: OrderMenuItem) {
  if (item.available_portions === null) return null;
  return Math.max(0, item.available_portions - (cart[item.id]?.qty ?? 0));
}

/** Aggiunge un pezzo rispettando scorte e limiti; se non può, restituisce il motivo. */
export function addToCart(
  cart: Cart,
  item: OrderMenuItem,
  limits: { maxItem?: number; maxOrder?: number } = {},
): { cart: Cart; blocked: AddBlockReason | null } {
  const qty = cart[item.id]?.qty ?? 0;
  if (remainingStock(cart, item) === 0) return { cart, blocked: "stock" };
  if (limits.maxItem !== undefined && qty >= limits.maxItem) return { cart, blocked: "item_limit" };
  if (limits.maxOrder !== undefined && cartItemCount(Object.values(cart)) >= limits.maxOrder) return { cart, blocked: "order_limit" };
  return {
    cart: {
      ...cart,
      [item.id]: {
        id: item.id,
        category: item.category,
        subcategory: item.subcategory,
        name: item.name,
        price: Number(item.price),
        qty: qty + 1,
        allergens: item.allergens ?? [],
      },
    },
    blocked: null,
  };
}

export function removeOneFromCart(cart: Cart, id: string): Cart {
  const line = cart[id];
  if (!line) return cart;
  if (line.qty <= 1) {
    const { [id]: _removed, ...rest } = cart;
    return rest;
  }
  return { ...cart, [id]: { ...line, qty: line.qty - 1 } };
}
