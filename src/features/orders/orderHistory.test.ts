import { describe, expect, it } from "vitest";
import {
  ORDER_HISTORY_KEY,
  addOrderToHistory,
  ordersForEvent,
  readOrderHistory,
  saveOrderHistory,
  type StoredOrder,
} from "./orderHistory";

function order(id: string, eventId = "event-1"): StoredOrder {
  return {
    event_id: eventId,
    event_name: "LAG",
    order_id: id,
    display_number: Number(id.replace(/\D/g, "")) || 1,
    alias: "Girasole",
    notes: null,
    items: [],
    total: 0,
    qr_token: "123e4567-e89b-42d3-a456-426614174000",
    status: "in_attesa_pagamento",
    saved_at: "2026-08-24T12:00:00.000Z",
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("orderHistory", () => {
  it("migra il vecchio ultimo ordine nello storico", () => {
    const legacy = order("order-1");
    const { status: _status, saved_at: _savedAt, ...oldShape } = legacy;
    const storage = memoryStorage({ "lag:last-submitted-order": JSON.stringify(oldShape) });

    const history = readOrderHistory(storage);

    expect(history).toHaveLength(1);
    expect(history[0].order_id).toBe("order-1");
    expect(history[0].status).toBe("in_attesa_pagamento");
  });

  it("aggiunge il nuovo ordine in testa senza duplicati", () => {
    const first = order("order-1");
    const second = order("order-2");

    expect(addOrderToHistory([first], second).map((item) => item.order_id))
      .toEqual(["order-2", "order-1"]);
    expect(addOrderToHistory([first], { ...first, status: "pagato" }))
      .toEqual([{ ...first, status: "pagato" }]);
  });

  it("conserva soltanto gli ordini dell'evento corrente", () => {
    expect(ordersForEvent([order("order-1"), order("order-2", "event-2")], "event-2"))
      .toEqual([order("order-2", "event-2")]);
  });

  it("salva lo storico e rimuove la chiave precedente", () => {
    const storage = memoryStorage({ "lag:last-submitted-order": "legacy" });
    saveOrderHistory([order("order-1")], storage);

    expect(storage.getItem(ORDER_HISTORY_KEY)).toContain("order-1");
    expect(storage.getItem("lag:last-submitted-order")).toBeNull();
  });
});
