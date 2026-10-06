import { describe, expect, it } from "vitest";
import { cashStationLabel, matchesOrderSearch } from "./workflow";

describe("order workflow", () => {
  it("dà un nome leggibile alle casse", () => {
    expect(cashStationLabel("cassa_5")).toBe("Cassa Esterna");
  });

  it("combina ricerca per numero e per nome ordine", () => {
    const order = { display_number: 42, alias: "Tavolo Girasole" };
    expect(matchesOrderSearch(order, "", "")).toBe(true);
    expect(matchesOrderSearch(order, "4", "giras")).toBe(true);
    expect(matchesOrderSearch(order, "43", "")).toBe(false);
    expect(matchesOrderSearch({ ...order, alias: null }, "", "giras")).toBe(false);
  });
});
