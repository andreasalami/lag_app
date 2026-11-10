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

/** Pezzi ancora aggiungibili di un prodotto; null significa scorte illimitate. Un prodotto sospeso ne ha zero. */
export function remainingStock(cart: Cart, item: OrderMenuItem) {
  if (item.suspended) return 0;
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
  if (limits.maxOrder !== undefined && cartItemCount(Object.values(cart)) >= limits.maxOrder)
    return { cart, blocked: "order_limit" };
  return { cart: { ...cart, [item.id]: lineFor(item, qty + 1) }, blocked: null };
}

function lineFor(item: OrderMenuItem, qty: number): OrderLine {
  return {
    id: item.id,
    category: item.category,
    subcategory: item.subcategory,
    name: item.name,
    price: Number(item.price),
    qty,
    allergens: item.allergens ?? [],
  };
}

/**
 * Riallinea il carrello al menu appena riletto: il menu può cambiare mentre il cliente ordina.
 * Toglie i prodotti eliminati, sospesi o terminati, riduce le quantità alle porzioni rimaste
 * e aggiorna i prezzi. Se non cambia nulla restituisce lo stesso carrello.
 */
export function reconcileCart(cart: Cart, items: OrderMenuItem[]) {
  const next: Cart = {};
  const removed: string[] = [];
  const reduced: string[] = [];
  let repriced = false;
  for (const line of Object.values(cart)) {
    const item = items.find((candidate) => candidate.id === line.id);
    const qty = !item || item.suspended ? 0 : Math.min(line.qty, item.available_portions ?? line.qty);
    if (!item || qty === 0) {
      removed.push(line.name);
      continue;
    }
    if (qty < line.qty) reduced.push(item.name);
    if (Number(item.price) !== line.price) repriced = true;
    next[item.id] = lineFor(item, qty);
  }
  const changed = removed.length > 0 || reduced.length > 0 || repriced;
  return { cart: changed ? next : cart, removed, reduced, repriced, changed };
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
