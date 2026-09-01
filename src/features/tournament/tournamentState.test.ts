import { describe, expect, it } from "vitest";
import { parseTournamentArchive, parseTournamentSnapshot } from "./tournamentState";

const snapshot = {
  size: 8,
  teams: Array.from({ length: 8 }, (_, index) => `Squadra ${index + 1}`),
  matches: {},
  overrides: {},
};

describe("tournament state", () => {
  it("valida uno snapshot coerente con la dimensione", () => {
    expect(parseTournamentSnapshot(snapshot)).toEqual(snapshot);
    expect(parseTournamentSnapshot({ ...snapshot, teams: snapshot.teams.slice(0, 7) })).toBeNull();
  });

  it("converte una riga archivio Supabase", () => {
    expect(parseTournamentArchive({
      ...snapshot,
      id: "snapshot-1",
      reason: "size_change",
      target_size: 16,
      created_at: "2026-09-01T17:00:00.000Z",
    })).toEqual({
      ...snapshot,
      id: "snapshot-1",
      reason: "size_change",
      targetSize: 16,
      createdAt: "2026-09-01T17:00:00.000Z",
    });
  });

  it("rifiuta metadati archivio non validi", () => {
    expect(parseTournamentArchive({
      ...snapshot,
      id: "snapshot-1",
      reason: "unknown",
      target_size: 16,
      created_at: "not-a-date",
    })).toBeNull();
  });
});

