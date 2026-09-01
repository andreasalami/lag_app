import { describe, expect, it } from "vitest";
import {
  fulfillmentStationForSubcategory,
  isCashStation,
  publicOrderStatusFromProgress,
} from "./workflow";

describe("order workflow", () => {
  it("consente soltanto le cinque casse configurabili", () => {
    expect(isCashStation("cassa_1")).toBe(true);
    expect(isCashStation("cassa_5")).toBe(true);
    expect(isCashStation("cassa_6")).toBe(false);
  });

  it("riunisce vini e bevande nella postazione Bar", () => {
    expect(fulfillmentStationForSubcategory("vini")).toBe("bar");
    expect(fulfillmentStationForSubcategory("bevande")).toBe("bar");
    expect(fulfillmentStationForSubcategory("birre")).toBe("birre");
    expect(fulfillmentStationForSubcategory("furgone")).toBe("furgone");
  });

  it("calcola gli stati pubblici senza modificare il totale dell'ordine", () => {
    const initial = [{ station: "birre" as const, quantity: 3, delivered: 0 }];
    expect(publicOrderStatusFromProgress(false, initial)).toBe("in_attesa_pagamento");
    expect(publicOrderStatusFromProgress(true, initial)).toBe("pagato");
    expect(publicOrderStatusFromProgress(true, [{ ...initial[0], delivered: 2 }])).toBe("ritiro_parziale");
    expect(publicOrderStatusFromProgress(true, [{ ...initial[0], delivered: 3 }])).toBe("consegnato");
  });
});
