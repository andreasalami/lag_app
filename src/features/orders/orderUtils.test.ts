import { describe, expect, it } from "vitest";
import { eventReportToCsv, orderingReasonMessage, parseQrPayload, type EventReport } from "./orderUtils";

describe("parseQrPayload", () => {
  it("estrae il token dal QR LAG", () => {
    expect(parseQrPayload("LAGORDER:123e4567-e89b-42d3-a456-426614174000"))
      .toBe("123e4567-e89b-42d3-a456-426614174000");
  });

  it("rifiuta contenuti QR estranei", () => {
    expect(parseQrPayload("https://example.com/phishing")).toBeNull();
  });
});

describe("eventReportToCsv", () => {
  it("esporta righe e totali senza alias o note", () => {
    const report: EventReport = {
      event_name: "LAG Test",
      closed_at: "2026-08-12T12:00:00.000Z",
      summary: { orders_paid: 1, revenue_total: 5 },
      products: [{ name: "Panino", category: "cibo", quantity: 1, revenue: 5 }],
      orders: [{
        number: 7,
        created_at: "2026-08-12T11:00:00.000Z",
        paid_at: "2026-08-12T11:05:00.000Z",
        status: "consegnato",
        items: [{ id: "p1", name: "Panino", category: "cibo", price: 5, qty: 1, allergens: [1] }],
        total: 5,
      }],
    };

    const csv = eventReportToCsv(report);
    expect(csv).toContain("ORDINI ANONIMI");
    expect(csv).toContain("1x Panino");
    expect(csv).not.toContain("alias");
    expect(csv).not.toContain("note");
  });
});

describe("orderingReasonMessage", () => {
  it("spiega il limite temporaneo senza dettagli tecnici", () => {
    expect(orderingReasonMessage("capacity_reached")).toContain("Riprova tra qualche minuto");
  });
});
