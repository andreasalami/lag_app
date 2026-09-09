type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type PendingOperation = {
  fingerprint: string;
  operationId: string;
};

const KEY_PREFIX = "lag:pending-operation:";
const memoryJournal = new Map<string, PendingOperation>();

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export function operationFingerprint(value: unknown) {
  return JSON.stringify(stableValue(value));
}

export function getOrCreateOperationId(
  scope: string,
  fingerprint: string,
  storage: BrowserStorage = localStorage,
  createUuid: () => string = () => crypto.randomUUID(),
) {
  const key = `${KEY_PREFIX}${scope}`;
  const inMemory = memoryJournal.get(key);
  if (inMemory?.fingerprint === fingerprint) return inMemory.operationId;
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const pending = JSON.parse(raw) as Partial<PendingOperation>;
      if (pending.fingerprint === fingerprint && typeof pending.operationId === "string") {
        memoryJournal.set(key, { fingerprint, operationId: pending.operationId });
        return pending.operationId;
      }
    }
  } catch {
    // A corrupt or unavailable journal must not prevent an operational action.
  }
  const operationId = createUuid();
  memoryJournal.set(key, { fingerprint, operationId });
  try {
    storage.setItem(key, JSON.stringify({ fingerprint, operationId } satisfies PendingOperation));
  } catch {
    // The database still receives an idempotency key for this page session.
  }
  return operationId;
}

export function clearOperationId(
  scope: string,
  operationId: string,
  storage: BrowserStorage = localStorage,
) {
  const key = `${KEY_PREFIX}${scope}`;
  if (memoryJournal.get(key)?.operationId === operationId) memoryJournal.delete(key);
  try {
    const raw = storage.getItem(key);
    if (!raw) return;
    const pending = JSON.parse(raw) as Partial<PendingOperation>;
    if (pending.operationId === operationId) storage.removeItem(key);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Private browsing may make storage unavailable; completion still stands.
    }
  }
}
