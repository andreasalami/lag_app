import { describe, expect, it } from "vitest";
import { eventEndMinutes, formatMinutes, toMinutes } from "./timeUtils";

describe("timeUtils", () => {
  it("converte e formatta gli orari", () => {
    expect(toMinutes("18:30")).toBe(1110);
    expect(formatMinutes(24 * 60 + 75)).toBe("01:15");
  });

  it("porta al giorno successivo gli eventi oltre mezzanotte", () => {
    expect(eventEndMinutes("23:30", "01:00")).toBe(25 * 60);
  });

  it("considera una chiusura uguale all'apertura come giorno successivo", () => {
    expect(eventEndMinutes("20:00", "20:00")).toBe(44 * 60);
  });
});
