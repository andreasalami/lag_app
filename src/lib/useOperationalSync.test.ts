import { describe, expect, it } from "vitest";
import { isOperationalDataStale } from "./useOperationalSync";

describe("operational sync health", () => {
  it("segnala dati obsoleti offline o oltre la soglia", () => {
    expect(isOperationalDataStale(false, 10_000, null, 10_001, 45_000)).toBe(true);
    expect(isOperationalDataStale(true, 10_000, null, 54_999, 45_000)).toBe(false);
    expect(isOperationalDataStale(true, 10_000, null, 55_001, 45_000)).toBe(true);
  });

  it("attende il primo errore prima di mostrare lo stato obsoleto", () => {
    expect(isOperationalDataStale(true, null, null, 10_000, 45_000)).toBe(false);
    expect(isOperationalDataStale(true, null, 9_000, 10_000, 45_000)).toBe(true);
  });
});
