import { describe, expect, it } from "vitest";
import { cashStationLabel, isCashStation, matchesOrderSearch } from "./workflow";

describe("order workflow", () => {
  it("consente soltanto le cinque casse configurabili", () => {
    expect(isCashStation("cassa_1")).toBe(true);
    expect(isCashStation("cassa_5")).toBe(true);
    expect(isCashStation("cassa_6")).toBe(false);
    expect(isCashStation(null)).toBe(false);
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
