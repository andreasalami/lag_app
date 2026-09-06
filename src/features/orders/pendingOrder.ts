import type { OrderLine } from "./types";
export type PendingOrderRequest = {
  requestId: string; qrToken: string; eventId: string; recoveryToken?: string;
  alias: string; notes: string; items: OrderLine[]; createdAt: string;
  preparationMode?: import("./types").PreparationMode;
};
const PREFIX = "lag:pending-order:";
type JournalStorage = Pick<Storage,"getItem"|"setItem"|"removeItem"|"key"|"length">;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function valid(value: unknown): value is PendingOrderRequest {
  if(!value || typeof value!=="object") return false;
  const p=value as Partial<PendingOrderRequest>;
  return typeof p.requestId==="string" && uuid.test(p.requestId)
    && typeof p.qrToken==="string" && uuid.test(p.qrToken)
    && typeof p.eventId==="string" && uuid.test(p.eventId)
    && typeof p.alias==="string" && typeof p.notes==="string" && typeof p.createdAt==="string"
    && (p.preparationMode===undefined || p.preparationMode==='immediate' || p.preparationMode==='deferred')
    && Array.isArray(p.items) && p.items.length>0 && p.items.length<=100
    && p.items.every(line=>line && typeof line.id==="string" && uuid.test(line.id)
      && typeof line.name==="string" && Number.isSafeInteger(line.qty) && line.qty>0);
}
export function readPendingOrder(storage?: JournalStorage): PendingOrderRequest | null {
  try {
    const target=storage ?? localStorage;
    const requests: PendingOrderRequest[]=[];
    for(let index=0;index<target.length;index++) {
      const key=target.key(index);
      if(!key?.startsWith(PREFIX)) continue;
      try {const value:unknown=JSON.parse(target.getItem(key) ?? "null");if(valid(value)) requests.push(value);} catch { /* A damaged entry must not hide other recoverable orders. */ }
    }
    return requests.sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0] ?? null;
  } catch {return null;}
}
export function savePendingOrder(request: PendingOrderRequest, storage?: JournalStorage): boolean {
  try {
    const target=storage ?? localStorage;
    target.setItem(PREFIX+request.requestId,JSON.stringify(request));
    return target.getItem(PREFIX+request.requestId)===JSON.stringify(request);
  } catch {return false;}
}
export function clearPendingOrder(requestId: string, storage?: JournalStorage) {
  try {(storage ?? localStorage).removeItem(PREFIX+requestId);} catch { /* A retained entry can safely retry the same request ID. */ }
}
