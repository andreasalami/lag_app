import { describe, expect, it } from "vitest";
import { addToCart, cartItemCount, cartTotal, removeOneFromCart, type Cart } from "./cart";
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
});
