import { describe, expect, it } from "vitest";
import { addToCart, cartItemCount, cartTotal, reconcileCart, removeOneFromCart, type Cart } from "./cart";
import type { OrderMenuItem } from "./types";

const beer: OrderMenuItem = {
  id: "beer",
  category: "bevande",
  subcategory: "birre",
  name: "Birra",
  price: 4.5,
  available_portions: 2,
  stock_capacity: 10,
  allergens: [1],
  suspended: false,
};

describe("cart", () => {
  it("non supera le porzioni disponibili", () => {
    let cart: Cart = {};
    cart = addToCart(cart, beer).cart;
    cart = addToCart(cart, beer).cart;
    const third = addToCart(cart, beer);
    expect(third.blocked).toBe("stock");
    expect(third.cart.beer.qty).toBe(2);
  });

  it("applica i limiti per prodotto e per ordine", () => {
    const unlimited = { ...beer, available_portions: null };
    const one = addToCart({}, unlimited, { maxItem: 1 }).cart;
    expect(addToCart(one, unlimited, { maxItem: 1 }).blocked).toBe("item_limit");
    expect(addToCart(one, { ...unlimited, id: "other" }, { maxOrder: 1 }).blocked).toBe("order_limit");
  });

  it("calcola totale e pezzi e rimuove una riga a quantità zero", () => {
    const cart = addToCart(addToCart({}, beer).cart, beer).cart;
    expect(cartTotal(Object.values(cart))).toBe(9);
    expect(cartItemCount(Object.values(cart))).toBe(2);
    expect(removeOneFromCart(removeOneFromCart(cart, "beer"), "beer")).toEqual({});
  });

  it("non aggiunge un prodotto sospeso", () => {
    expect(addToCart({}, { ...beer, suspended: true }).blocked).toBe("stock");
  });
});

describe("reconcileCart", () => {
  const water: OrderMenuItem = { ...beer, id: "water", name: "Acqua", price: 1, available_portions: null };
  const cart = addToCart(addToCart(addToCart({}, beer).cart, beer).cart, water).cart;

  it("lascia intatto il carrello se il menu non è cambiato", () => {
    const result = reconcileCart(cart, [beer, water]);
    expect(result.changed).toBe(false);
    expect(result.cart).toBe(cart);
  });

  it("toglie i prodotti eliminati, sospesi o terminati", () => {
    expect(reconcileCart(cart, [water]).removed).toEqual(["Birra"]);
    expect(reconcileCart(cart, [{ ...beer, suspended: true }, water]).removed).toEqual(["Birra"]);
    const soldOut = reconcileCart(cart, [{ ...beer, available_portions: 0 }, water]);
    expect(soldOut.removed).toEqual(["Birra"]);
    expect(Object.keys(soldOut.cart)).toEqual(["water"]);
  });

  it("riduce la quantità alle porzioni rimaste e aggiorna i prezzi", () => {
    const result = reconcileCart(cart, [{ ...beer, available_portions: 1, price: 5 }, water]);
    expect(result.reduced).toEqual(["Birra"]);
    expect(result.repriced).toBe(true);
    expect(result.cart.beer).toMatchObject({ qty: 1, price: 5 });
    expect(cartTotal(Object.values(result.cart))).toBe(6);
  });
});
