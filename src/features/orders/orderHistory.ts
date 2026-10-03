import type { KitchenState, OrderStatus, PreparationMode, SubmittedOrder } from "./types";
import type { FulfillmentProgress } from "./workflow";
import { supabase } from "../../lib/supabaseClient";

export type PublicOrderStatus = OrderStatus;

export const ORDER_STATUS_LABELS: Record<PublicOrderStatus, string> = {
  in_attesa_pagamento: "Da pagare",
  pagato: "In preparazione",
  ritiro_parziale: "Ritiro parziale",
  consegnato: "Ritirato",
  annullato: "Annullato",
};

export type StoredOrder = SubmittedOrder & {
  status: PublicOrderStatus;
  saved_at: string;
  progress?: FulfillmentProgress[];
  recovery_enabled?: boolean;
  event_closed_at?: string | null;
};

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const ORDER_HISTORY_KEY = "lag:submitted-orders";
const LEGACY_ORDER_KEY = "lag:last-submitted-order";

const VALID_STATUSES = new Set<PublicOrderStatus>([
  "in_attesa_pagamento",
  "pagato",
  "ritiro_parziale",
  "consegnato",
  "annullato",
]);

function isSubmittedOrder(value: unknown): value is SubmittedOrder {
  if (!value || typeof value !== "object") return false;
  const order = value as Partial<SubmittedOrder>;
  return (
    typeof order.event_id === "string" &&
    typeof order.order_id === "string" &&
    typeof order.display_number === "number" &&
    typeof order.alias === "string" &&
    typeof order.qr_token === "string" &&
    Array.isArray(order.items)
  );
}

function normalizeOrder(value: unknown, fallbackDate: string): StoredOrder | null {
  if (!isSubmittedOrder(value)) return null;
  const candidate = value as Partial<StoredOrder>;
  return {
    ...value,
    status: candidate.status && VALID_STATUSES.has(candidate.status) ? candidate.status : "in_attesa_pagamento",
    saved_at: typeof candidate.saved_at === "string" ? candidate.saved_at : fallbackDate,
  };
}

export function readOrderHistory(storage?: BrowserStorage): StoredOrder[] {
  const fallbackDate = new Date().toISOString();
  try {
    storage = storage ?? localStorage;
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

export function saveOrderHistory(orders: StoredOrder[], storage?: BrowserStorage) {
  try {
    storage = storage ?? localStorage;
    storage.setItem(ORDER_HISTORY_KEY, JSON.stringify(orders));
    storage.removeItem(LEGACY_ORDER_KEY);
    return true;
  } catch {
    return false;
  }
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

export function orderStatusClassName(status: PublicOrderStatus) {
  if (status === "consegnato") return "text-(--state-success)";
  if (status === "annullato") return "text-(--state-error)";
  if (status === "pagato" || status === "ritiro_parziale") return "text-(--state-warning)";
  return "text-(--accent-primary)";
}

type StatusUpdate = Pick<StoredOrder, "status" | "progress"> &
  Partial<Pick<StoredOrder, "kitchen_state" | "preparation_mode">>;

const KITCHEN_STATES = new Set<KitchenState>(["none", "reserved", "dormant", "waiting", "active", "done"]);

/** Chiede al server lo stato aggiornato degli ordini, a lotti di 50 token QR. */
export async function fetchOrderStatusUpdates(orders: StoredOrder[]) {
  const updates = new Map<string, StatusUpdate>();
  const batches = Array.from({ length: Math.ceil(orders.length / 50) }, (_, index) =>
    orders.slice(index * 50, (index + 1) * 50),
  );
  const results = await Promise.all(
    batches.map(async (batch) => {
      const { data, error } = await supabase.rpc("get_public_order_statuses", {
        p_qr_tokens: batch.map((order) => order.qr_token),
      });
      return error
        ? []
        : (data as Array<{
            order_id?: unknown;
            status?: unknown;
            progress?: unknown;
            kitchen_state?: unknown;
            preparation_mode?: unknown;
          }>);
    }),
  );
  results.flat().forEach((result) => {
    if (typeof result.order_id !== "string" || !isPublicOrderStatus(result.status)) return;
    const update: StatusUpdate = {
      status: result.status,
      progress: Array.isArray(result.progress) ? (result.progress as FulfillmentProgress[]) : undefined,
    };
    if (KITCHEN_STATES.has(result.kitchen_state as KitchenState))
      update.kitchen_state = result.kitchen_state as KitchenState;
    if (result.preparation_mode === "immediate" || result.preparation_mode === "deferred") {
      update.preparation_mode = result.preparation_mode as PreparationMode;
    }
    updates.set(result.order_id, update);
  });
  return updates;
}

export function applyStatusUpdates(orders: StoredOrder[], updates: Map<string, StatusUpdate>) {
  return orders.map((order) => {
    const update = updates.get(order.order_id);
    return update ? { ...order, ...update } : order;
  });
}

export async function syncOrderHistoryStatuses(orders: StoredOrder[]) {
  if (orders.length === 0) return orders;
  const next = applyStatusUpdates(orders, await fetchOrderStatusUpdates(orders));
  saveOrderHistory(next);
  return next;
}
