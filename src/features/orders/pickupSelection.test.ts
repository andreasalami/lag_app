import { describe, expect, it } from "vitest";
import { isPickupSelectionValid, remainingPickupSelection, remainingToPickUp, selectedPickupCount } from "./pickupQuantities";

const beer = { id: "beer", name: "Birra", quantity: 10, delivered_quantity: 0 };
const food = { id: "food", name: "Panino", quantity: 3, delivered_quantity: 1 };

describe("ritiri parziali", () => {
  it("consente due birre su dieci e conserva le altre otto", () => {
    expect(isPickupSelectionValid([beer], { beer: 2 })).toBe(true);
    expect(remainingToPickUp({ ...beer, delivered_quantity: 2 })).toBe(8);
    expect(beer.quantity).toBe(10);
  });
  it("supporta quantità diverse e prodotti lasciati a zero", () => {
    expect(isPickupSelectionValid([beer, food], { beer: 2, food: 0 })).toBe(true);
    expect(selectedPickupCount({ beer: 2, food: 0 })).toBe(2);
    expect(remainingPickupSelection([beer, food])).toEqual({ beer: 10, food: 2 });
  });
  it("blocca quantità eccedenti, frazionarie e non valide", () => {
    for (const quantity of [11, -1, 1.5, NaN, Infinity]) {
      expect(isPickupSelectionValid([beer], { beer: quantity })).toBe(false);
    }
  });
  it("blocca una selezione diventata obsoleta dopo un ritiro concorrente", () => {
    expect(isPickupSelectionValid([{ ...beer, delivered_quantity: 9 }], { beer: 2 })).toBe(false);
    expect(isPickupSelectionValid([food], { beer: 2 })).toBe(false);
    expect(isPickupSelectionValid([food], { beer: 0, food: 1 })).toBe(true);
  });
});
