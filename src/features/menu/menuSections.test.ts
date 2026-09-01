import { describe, expect, it } from "vitest";
import { isMenuSectionForCategory, menuSectionFor } from "./menuSections";

describe("menuSectionFor", () => {
  it("divide i piatti nelle sezioni della cucina", () => {
    expect(menuSectionFor("cibo", "Risotto alla zucca")).toBe("primi");
    expect(menuSectionFor("cibo", "Panino con salamella")).toBe("secondi");
    expect(menuSectionFor("cibo", "Patatine fritte")).toBe("contorni");
    expect(menuSectionFor("cibo", "Torta di mele")).toBe("dolci");
  });

  it("divide le consumazioni nelle sezioni del bar", () => {
    expect(menuSectionFor("bevande", "Birra media")).toBe("birre");
    expect(menuSectionFor("bevande", "Vino bianco")).toBe("vini");
    expect(menuSectionFor("bevande", "Spritz")).toBe("drinks");
    expect(menuSectionFor("bevande", "Cola")).toBe("bevande");
  });

  it("impedisce combinazioni tra reparto e sezione non valide", () => {
    expect(isMenuSectionForCategory("cibo", "primi")).toBe(true);
    expect(isMenuSectionForCategory("cibo", "birre")).toBe(false);
    expect(isMenuSectionForCategory("bevande", "drinks")).toBe(true);
    expect(isMenuSectionForCategory("bevande", "dolci")).toBe(false);
  });
});
