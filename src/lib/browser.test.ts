import { afterEach, describe, expect, it, vi } from "vitest";
import { pollWhileVisible } from "./browser";

describe("pollWhileVisible", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aggiorna solo a scheda visibile, anche al ritorno, e si ferma con la pulizia", () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const page = {
      visibilityState: "visible",
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };
    vi.stubGlobal("document", page);
    vi.stubGlobal("window", globalThis);
    const refresh = vi.fn();

    const stop = pollWhileVisible(refresh, 1_000);
    vi.advanceTimersByTime(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    page.visibilityState = "hidden";
    vi.advanceTimersByTime(3_000);
    listeners.forEach((listener) => listener());
    expect(refresh).toHaveBeenCalledTimes(1);

    page.visibilityState = "visible";
    listeners.forEach((listener) => listener());
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(5_000);
    expect(listeners.size).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
