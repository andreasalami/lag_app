import { describe, expect, it } from "vitest";
import { commitmentSummary, parseCommitments } from "./menuAvailability";

describe("commitmentSummary", () => {
  it("distingue porzioni pagate da preparare e porzioni in ordini non pagati", () => {
    expect(commitmentSummary({ paid_portions: 12, paid_orders: 9, unpaid_portions: 5, unpaid_orders: 4 })).toBe(
      "Ancora da preparare: 12 porzioni in 9 ordini pagati, più 5 porzioni in 4 ordini non ancora pagati.",
    );
    expect(commitmentSummary({ paid_portions: 1, paid_orders: 1, unpaid_portions: 0, unpaid_orders: 0 })).toBe(
      "Ancora da preparare: 1 porzione in 1 ordine pagato.",
    );
    expect(commitmentSummary({ paid_portions: 0, paid_orders: 0, unpaid_portions: 1, unpaid_orders: 1 })).toBe(
      "Ancora da preparare: 1 porzione in 1 ordine non ancora pagato.",
    );
  });

  it("dice quando nessun ordine contiene il prodotto", () => {
    expect(commitmentSummary(undefined)).toBe("Nessun ordine in corso contiene questo prodotto.");
  });
});

describe("parseCommitments", () => {
  it("accetta solo righe con la forma attesa", () => {
    const parsed = parseCommitments([
      { id: "a", paid_portions: 3, paid_orders: 1, unpaid_portions: 2, unpaid_orders: 1 },
      { id: "b", paid_portions: "3" },
      null,
    ]);
    expect([...parsed.keys()]).toEqual(["a"]);
    expect(parseCommitments("errore").size).toBe(0);
  });
});
