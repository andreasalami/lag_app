import type { SubmittedOrder } from "./types";

export type PublicOrderStatus = "in_attesa_pagamento" | "pagato" | "consegnato" | "annullato";

export type StoredOrder = SubmittedOrder & {
  status: PublicOrderStatus;
  saved_at: string;
};

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const ORDER_HISTORY_KEY = "lag:submitted-orders";
const LEGACY_ORDER_KEY = "lag:last-submitted-order";

const VALID_STATUSES = new Set<PublicOrderStatus>([
  "in_attesa_pagamento",
  "pagato",
  "consegnato",
  "annullato",
]);

function isSubmittedOrder(value: unknown): value is SubmittedOrder {
  if (!value || typeof value !== "object") return false;
  const order = value as Partial<SubmittedOrder>;
  return typeof order.event_id === "string"
    && typeof order.order_id === "string"
    && typeof order.display_number === "number"
    && typeof order.alias === "string"
    && typeof order.qr_token === "string"
    && Array.isArray(order.items);
}

function normalizeOrder(value: unknown, fallbackDate: string): StoredOrder | null {
  if (!isSubmittedOrder(value)) return null;
  const candidate = value as Partial<StoredOrder>;
  return {
    ...value,
    status: candidate.status && VALID_STATUSES.has(candidate.status)
      ? candidate.status
      : "in_attesa_pagamento",
    saved_at: typeof candidate.saved_at === "string" ? candidate.saved_at : fallbackDate,
  };
}

export function readOrderHistory(storage: BrowserStorage = localStorage): StoredOrder[] {
  const fallbackDate = new Date().toISOString();
  try {
    const rawHistory = storage.getItem(ORDER_HISTORY_KEY);
    if (rawHistory) {
      const parsed = JSON.parse(rawHistory) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.flatMap((value) => {
          const normalized = normalizeOrder(value, fallbackDate);
          return normalized ? [normalized] : [];
        });
      }
    }

    const rawLegacy = storage.getItem(LEGACY_ORDER_KEY);
    if (!rawLegacy) return [];
    const normalized = normalizeOrder(JSON.parse(rawLegacy) as unknown, fallbackDate);
    return normalized ? [normalized] : [];
  } catch {
    return [];
  }
}

export function saveOrderHistory(orders: StoredOrder[], storage: BrowserStorage = localStorage) {
  storage.setItem(ORDER_HISTORY_KEY, JSON.stringify(orders));
  storage.removeItem(LEGACY_ORDER_KEY);
}

export function addOrderToHistory(orders: StoredOrder[], order: StoredOrder) {
  return [order, ...orders.filter((candidate) => candidate.order_id !== order.order_id)];
}

export function ordersForEvent(orders: StoredOrder[], eventId: string | null) {
  return eventId ? orders.filter((order) => order.event_id === eventId) : [];
}

export function isPublicOrderStatus(value: unknown): value is PublicOrderStatus {
  return typeof value === "string" && VALID_STATUSES.has(value as PublicOrderStatus);
}
