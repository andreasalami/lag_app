import { describe, expect, it } from "vitest";
import { currentRoundLabel, latestTournamentResults } from "./tournamentOverview";
import type { TournamentSnapshot } from "./tournamentState";

function snapshot(): TournamentSnapshot {
  return {
    size: 8,
    teams: ["A", "B", "C", "D", "E", "F", "G", "H"],
    matches: {},
    overrides: {},
  };
}

describe("tournamentOverview", () => {
  it("mostra il primo turno non ancora completato", () => {
    const state = snapshot();
    expect(currentRoundLabel(state)).toBe("Quarti di finale");
    state.matches = {
      "0-0": { winner: "A", scoreA: 2, scoreB: 0 },
      "0-1": { winner: "B", scoreA: 0, scoreB: 1 },
      "0-2": { winner: "A", scoreA: 3, scoreB: 2 },
      "0-3": { winner: "B", scoreA: 1, scoreB: 2 },
    };
    expect(currentRoundLabel(state)).toBe("Semifinale");
  });

  it("ordina i risultati dal più recente e applica il limite", () => {
    const state = snapshot();
    state.matches = {
      "0-0": { winner: "A", scoreA: 2, scoreB: 0, completedAt: "2026-09-01T20:00:00.000Z" },
      "0-1": { winner: "B", scoreA: 0, scoreB: 1, completedAt: "2026-09-01T20:10:00.000Z" },
      "0-2": { winner: "A", scoreA: 3, scoreB: 2, completedAt: "2026-09-01T20:05:00.000Z" },
    };
    expect(latestTournamentResults(state, 2).map((result) => result.key)).toEqual(["0-1", "0-2"]);
  });

  it("segnala la conclusione dopo la finale", () => {
    const state = snapshot();
    state.matches = {
      "0-0": { winner: "A", scoreA: 1, scoreB: 0 },
      "0-1": { winner: "A", scoreA: 1, scoreB: 0 },
      "0-2": { winner: "A", scoreA: 1, scoreB: 0 },
      "0-3": { winner: "A", scoreA: 1, scoreB: 0 },
      "1-0": { winner: "A", scoreA: 1, scoreB: 0 },
      "1-1": { winner: "A", scoreA: 1, scoreB: 0 },
      "2-0": { winner: "A", scoreA: 1, scoreB: 0 },
    };
    expect(currentRoundLabel(state)).toBe("Torneo concluso");
  });
});
