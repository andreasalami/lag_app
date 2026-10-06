import { describe, expect, it } from "vitest";
import { restoredStation } from "./stationMemory";
import { CASH_STATIONS } from "./workflow";

describe("station memory", () => {
  const saved = JSON.stringify({ station: "cassa_2", eventId: "event-1" });

  it("riprende la postazione solo nello stesso evento aperto", () => {
    expect(restoredStation(saved, CASH_STATIONS, "event-1")).toBe("cassa_2");
    expect(restoredStation(saved, CASH_STATIONS, "event-2")).toBeNull();
    expect(restoredStation(saved, CASH_STATIONS, null)).toBeNull();
  });

  it("senza rete tiene l'ultima scelta, ma rifiuta valori estranei o vecchi", () => {
    expect(restoredStation(saved, CASH_STATIONS, undefined)).toBe("cassa_2");
    expect(
      restoredStation(JSON.stringify({ station: "cassa_9", eventId: "event-1" }), CASH_STATIONS, "event-1"),
    ).toBeNull();
    expect(restoredStation("cassa_2", CASH_STATIONS, "event-1")).toBeNull();
    expect(restoredStation(null, CASH_STATIONS, "event-1")).toBeNull();
  });
});
