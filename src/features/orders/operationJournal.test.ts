import { describe, expect, it } from "vitest";
import { clearOperationId, getOrCreateOperationId, operationFingerprint } from "./operationJournal";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("operation journal", () => {
  it("riusa lo stesso UUID finché l'operazione ambigua non è conclusa", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const uuid = () => `operation-${++sequence}`;
    const first = getOrCreateOperationId("pay:1", "same", storage, uuid);
    const retry = getOrCreateOperationId("pay:1", "same", storage, uuid);
    expect(retry).toBe(first);
    clearOperationId("pay:1", first, storage);
    expect(getOrCreateOperationId("pay:1", "same", storage, uuid)).not.toBe(first);
  });

  it("genera una nuova operazione quando cambia il payload", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const uuid = () => `operation-${++sequence}`;
    const first = getOrCreateOperationId("deliver:1", "qty:1", storage, uuid);
    const changed = getOrCreateOperationId("deliver:1", "qty:2", storage, uuid);
    expect(changed).not.toBe(first);
  });

  it("produce fingerprint stabili indipendentemente dall'ordine delle chiavi", () => {
    expect(operationFingerprint({ station: "bar", items: [{ qty: 2, id: "a" }] }))
      .toBe(operationFingerprint({ items: [{ id: "a", qty: 2 }], station: "bar" }));
  });
});
