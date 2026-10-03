import { describe, expect, it } from "vitest";
import {
  formatEuro,
  headlineSentences,
  hourlyBars,
  leastSentence,
  parseIncomeSnapshot,
  peakSentence,
  summarizeSections,
  type IncomeSnapshot,
  type SnapshotProduct,
} from "./incomeSnapshot";
import { createIncomeSnapshotPdf } from "./incomeSnapshotPdf";

const product = (
  name: string,
  section: SnapshotProduct["section"],
  quantity: number,
  category: SnapshotProduct["category"] = "cibo",
): SnapshotProduct => ({ name, category, section, quantity, revenue: quantity * 5 });

const snapshot: IncomeSnapshot = {
  event_name: "LAG di prova",
  generated_at: "2026-10-02T19:41:00Z",
  revenue_total: 3482,
  orders_paid: 214,
  hours: [
    { hour: "2026-10-02T23:00:00", orders: 30, revenue: 480 },
    { hour: "2026-10-02T21:00:00", orders: 60, revenue: 890 },
    { hour: "2026-10-03T01:00:00", orders: 5, revenue: 72 },
  ],
  products: [
    product("Tiramisù", "dolci", 0),
    product("Torta paradiso", "dolci", 22),
    product("Gelato", "dolci", 15),
    product("Crostata", "dolci", 3),
    product("Patatine", "contorni", 98),
    product("Polenta", "contorni", 22),
    product("Birra media", "birre", 142, "bevande"),
    product("Vino rosso", "vini", 0, "bevande"),
  ],
};

describe("income snapshot", () => {
  it("per sezione: i due più venduti con la percentuale e il meno venduto, anche a zero", () => {
    const [dolci] = summarizeSections(snapshot.products, "cibo").filter((summary) => summary.label === "Dolci");
    expect(dolci.top.map((row) => [row.name, row.quantity, Math.round(row.share * 100)])).toEqual([
      ["Torta paradiso", 22, 55],
      ["Gelato", 15, 38],
    ]);
    expect(dolci.least?.name).toBe("Tiramisù");
    expect(leastSentence(dolci.least!)).toBe("Meno venduto: Tiramisù, nessun pezzo venduto finora.");
  });

  it("con due soli prodotti non ripete il meno venduto; sezioni vuote escluse", () => {
    const sections = summarizeSections(snapshot.products, "cibo");
    expect(sections.map((summary) => summary.label)).toEqual(["Contorni", "Dolci"]);
    expect(sections[0].least).toBeNull();
    const vini = summarizeSections(snapshot.products, "bevande").find((summary) => summary.label === "Vini");
    expect(vini?.total).toBe(0);
  });

  it("riempie le ore senza incassi e trova l'ora di punta, anche dopo mezzanotte", () => {
    const bars = hourlyBars(snapshot.hours);
    expect(bars.map((bar) => [bar.label, bar.revenue])).toEqual([
      ["21", 890],
      ["22", 0],
      ["23", 480],
      ["00", 0],
      ["01", 72],
    ]);
    expect(peakSentence(bars)).toBe("Il momento più intenso è stato tra le 21 e le 22: 890,00 €.");
  });

  it("separa due serate con il giorno invece di riempire le ore del giorno", () => {
    const bars = hourlyBars([
      { hour: "2026-10-02T21:00:00", orders: 5, revenue: 300 },
      { hour: "2026-10-02T23:00:00", orders: 4, revenue: 200 },
      { hour: "2026-10-03T21:00:00", orders: 9, revenue: 700 },
    ]);
    expect(bars.map((bar) => [bar.label, bar.day])).toEqual([
      ["21", "venerdì"],
      ["22", null],
      ["23", null],
      ["21", "sabato"],
    ]);
    expect(peakSentence(bars)).toBe("Il momento più intenso è stato sabato tra le 21 e le 22: 700,00\u00a0€.");
  });

  it("un orario anomalo non genera migliaia di colonne", () => {
    expect(
      hourlyBars([
        { hour: "1970-01-01T01:00:00", orders: 1, revenue: 5 },
        { hour: "2026-10-02T21:00:00", orders: 1, revenue: 5 },
      ]),
    ).toHaveLength(2);
  });

  it("frasi accessibili anche senza ordini", () => {
    expect(headlineSentences({ ...snapshot, orders_paid: 0, revenue_total: 0 })).toEqual([
      "Non ci sono ancora ordini pagati.",
    ]);
    expect(headlineSentences({ ...snapshot, orders_paid: 1, revenue_total: 12 })).toEqual([
      "Da 1 ordine pagato. In media ogni ordine vale 12,00 €.",
    ]);
    expect(peakSentence([])).toBe("Non ci sono ancora incassi da mostrare ora per ora.");
    expect(formatEuro(3482)).toBe("3.482,00 €");
  });

  it("rifiuta risposte del server non valide", () => {
    expect(parseIncomeSnapshot({ ...snapshot, revenue_total: "3482.00" })?.revenue_total).toBe(3482);
    expect(parseIncomeSnapshot({ ...snapshot, hours: [{ hour: "21:00", orders: 1, revenue: 1 }] })).toBeNull();
    expect(parseIncomeSnapshot({ ...snapshot, products: [product("X", "birre", 1)] })).toBeNull();
    expect(parseIncomeSnapshot(null)).toBeNull();
  });

  it("genera il PDF con i testi principali", async () => {
    const pdf = await createIncomeSnapshotPdf(snapshot);
    const source = pdf.output();
    expect(source).toContain("Situazione incassi");
    expect(source).toContain("Torta paradiso");
    expect(source).toContain("non contiene nomi");
  });
});
