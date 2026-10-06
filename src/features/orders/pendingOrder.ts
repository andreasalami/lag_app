import type { OrderLine, PreparationMode } from "./types";
import { UUID_PATTERN } from "./orderUtils";

export type PendingOrderRequest = {
  requestId: string;
  qrToken: string;
  eventId: string;
  recoveryToken?: string;
  alias: string;
  notes: string;
  items: OrderLine[];
  createdAt: string;
  preparationMode?: PreparationMode;
};

const PREFIX = "lag:pending-order:";
type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function valid(value: unknown): value is PendingOrderRequest {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<PendingOrderRequest>;
  return (
    typeof p.requestId === "string" &&
    UUID_PATTERN.test(p.requestId) &&
    typeof p.qrToken === "string" &&
    UUID_PATTERN.test(p.qrToken) &&
    typeof p.eventId === "string" &&
    UUID_PATTERN.test(p.eventId) &&
    typeof p.alias === "string" &&
    typeof p.notes === "string" &&
    typeof p.createdAt === "string" &&
    (p.preparationMode === undefined || p.preparationMode === "immediate" || p.preparationMode === "deferred") &&
    Array.isArray(p.items) &&
    p.items.length > 0 &&
    p.items.length <= 100 &&
    p.items.every(
      (line) =>
        line &&
        typeof line.id === "string" &&
        UUID_PATTERN.test(line.id) &&
        typeof line.name === "string" &&
        Number.isSafeInteger(line.qty) &&
        line.qty > 0,
    )
  );
}

export function readPendingOrder(storage?: JournalStorage): PendingOrderRequest | null {
  try {
    const target = storage ?? localStorage;
    const requests: PendingOrderRequest[] = [];
    for (let index = 0; index < target.length; index++) {
      const key = target.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const value: unknown = JSON.parse(target.getItem(key) ?? "null");
        if (valid(value)) requests.push(value);
      } catch {
        // Una voce danneggiata non deve nascondere gli altri ordini recuperabili.
      }
    }
    return requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
  } catch {
    return null;
  }
}

export function savePendingOrder(request: PendingOrderRequest, storage?: JournalStorage): boolean {
  try {
    const target = storage ?? localStorage;
    target.setItem(PREFIX + request.requestId, JSON.stringify(request));
    return target.getItem(PREFIX + request.requestId) === JSON.stringify(request);
  } catch {
    return false;
  }
}

export function clearPendingOrder(requestId: string, storage?: JournalStorage) {
  try {
    (storage ?? localStorage).removeItem(PREFIX + requestId);
  } catch {
    // Una voce rimasta può ripetere in sicurezza la stessa richiesta.
  }
}

/** Una richiesta di un altro evento non si può più inviare (vedi pruneOrderHistory): si elimina. */
export function clearPendingOrdersOutside(eventId: string | null, storage?: JournalStorage) {
  try {
    const target = storage ?? localStorage;
    const stale: string[] = [];
    for (let index = 0; index < target.length; index++) {
      const key = target.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const value: unknown = JSON.parse(target.getItem(key) ?? "null");
        if (!valid(value) || value.eventId !== eventId) stale.push(key);
      } catch {
        stale.push(key);
      }
    }
    stale.forEach((key) => target.removeItem(key));
  } catch {
    // Senza memoria locale non c'è nulla da eliminare.
  }
}
