import { describe, expect, it } from "vitest";
import { eventReportToCsv, orderingReasonMessage, parseQrPayload, submitFailure, type EventReport } from "./orderUtils";

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
        items: [{ id: "p1", name: "Panino", category: "cibo", subcategory: "secondi", price: 5, qty: 1, allergens: [1] }],
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

describe("CSV formula safety", () => {
  it.each(["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\t=1+1", "  =1+1"])("neutralizza %s", (name) => {
    const report: EventReport = {event_name:name,closed_at:"2026-09-05T12:00:00Z",summary:{},products:[{name,category:"cibo",quantity:1,revenue:5}],orders:[]};
    const csv=eventReportToCsv(report);
    expect(csv).toContain("REPORT EVENTO;'"+name);
    expect(csv).toContain("'"+name+";cibo;1;5.00");
  });
});

describe("submitFailure", () => {
  const limits = { maxItem: 25, maxOrder: 60 };

  it("lascia la richiesta salvata quando l'esito è incerto", () => {
    for (const code of ["", "order_outcome_unknown", "public_order_rate_limit", "challenge_failed"]) {
      const failure = submitFailure(code, limits);
      expect(failure.definitive).toBe(false);
      expect(failure.message).toContain("Recupera ordine");
    }
  });

  it("scarta la richiesta sui rifiuti definitivi e non invita a recuperarla", () => {
    for (const code of ["stock_unavailable:Birra", "public_order_quantity_limit", "order_total_too_high", "event_changed", "request_id_conflict", "capacity_reached", "ordering_paused", "event_closed", "not_open_yet", "no_event", "invalid_alias", "notes_too_long"]) {
      const failure = submitFailure(code, limits);
      expect(failure.definitive, code).toBe(true);
      expect(failure.message, code).not.toContain("Recupera ordine");
    }
  });

  it("riporta i dettagli utili e chiede di ricaricare il menu quando serve", () => {
    expect(submitFailure("stock_unavailable:Birra, Panino", limits)).toMatchObject({ reloadCatalog: true, message: expect.stringContaining("Birra, Panino") });
    expect(submitFailure("public_order_quantity_limit", { maxItem: 10, maxOrder: 30 }).message).toContain("10 pezzi per prodotto o 30 articoli");
  });
});
