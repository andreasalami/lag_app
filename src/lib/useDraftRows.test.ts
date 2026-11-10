import { describe, expect, it } from "vitest";
import { changedFields, draftUuid, mergeServerRows, newDraftId } from "./useDraftRows";

type Row = { id: string; name: string; price: number; stock: number | null };
const row = (id: string, name: string, price: number, stock: number | null = null): Row => ({ id, name, price, stock });

describe("changedFields", () => {
  it("invia solo i campi cambiati, più l'id", () => {
    expect(changedFields(row("a", "Birra", 5, 10), row("a", "Birra", 4, 10))).toEqual({ id: "a", price: 5 });
    expect(changedFields(row("a", "Birra", 4, null), row("a", "Birra", 4, 10))).toEqual({ id: "a", stock: null });
  });
});

describe("draft ids", () => {
  it("una riga nuova porta già la uuid che avrà nel database", () => {
    expect(draftUuid(newDraftId())).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("mergeServerRows", () => {
  const saved = [row("a", "Birra", 4, 50), row("b", "Vino", 5, null)];

  it("i campi non toccati seguono il database", () => {
    const server = [row("a", "Birra", 4, 45), row("b", "Vino", 6, null)];
    expect(mergeServerRows(saved, saved, server)).toEqual({ rows: server, saved: server });
  });

  it("un campo modificato resta, insieme al valore che si vedeva quando è stato cambiato", () => {
    const rows = [row("a", "Birra", 4, 80), saved[1]];
    const merged = mergeServerRows(rows, saved, [row("a", "Birra media", 4, 45), saved[1]]);
    // Nome aggiornato da un altro dispositivo; scorta 80 scritta vedendo 50: al salvataggio resta +30.
    expect(merged.rows[0]).toEqual(row("a", "Birra media", 4, 80));
    expect(merged.saved[0]).toEqual(row("a", "Birra media", 4, 50));
  });

  it("aggiunge le righe nuove, toglie quelle eliminate altrove e conserva la bozza locale", () => {
    const draft = row(newDraftId(), "Nuovo", 1);
    const rows = [saved[1], draft]; // "a" eliminata qui, non ancora salvata
    const merged = mergeServerRows(rows, saved, [saved[0], row("c", "Acqua", 1)]);
    expect(merged.rows).toEqual([row("c", "Acqua", 1), draft]);
    expect(merged.saved.map((item) => item.id)).toEqual(["a", "c"]);
  });
});
