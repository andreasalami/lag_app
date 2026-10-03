import { describe, expect, it } from "vitest";
import { staffPage, staffPagesFor } from "./staffPages";

describe("staffPages", () => {
  const hashes = (role: Parameters<typeof staffPagesFor>[0], group: "sections" | "operations") =>
    staffPagesFor(role, group).map((page) => page.hash);

  it("dà a ogni ruolo solo le sue pagine", () => {
    expect(hashes("bar", "sections")).toEqual(["gestione-menu"]);
    expect(hashes("bar", "operations")).toEqual(["bar"]);
    expect(hashes("cassa", "sections")).toEqual(["gestione-evento"]);
    expect(hashes("staff", "operations")).toEqual([]);
    expect(hashes("pending", "sections")).toEqual([]);
    expect(hashes("admin", "operations")).toEqual(["cassa", "cucina", "bar"]);
  });

  it("riconosce solo le pagine riservate", () => {
    expect(staffPage("gestione-torneo")?.roles).toEqual(["tournament_manager", "admin"]);
    expect(staffPage("ordina")).toBeUndefined();
  });
});
