import { describe, expect, it } from "vitest";
import {
  defaultTeams,
  matchKey,
  matchesInRound,
  resolveSlot,
  roundLabel,
  totalRounds,
  winnerFromScore,
  type MatchesMap,
} from "./bracketUtils";

describe("bracketUtils", () => {
  it("calcola turni, incontri ed etichette", () => {
    expect(totalRounds(16)).toBe(4);
    expect(matchesInRound(16, 0)).toBe(8);
    expect(matchesInRound(16, 3)).toBe(1);
    expect(roundLabel(16, 3)).toBe("Finale");
  });

  it("propaga ricorsivamente il vincitore", () => {
    const teams = defaultTeams(8);
    const matches: MatchesMap = {
      [matchKey(0, 0)]: { winner: "B", scoreA: 1, scoreB: 2 },
    };
    expect(resolveSlot(1, 0, "A", teams, matches, {})).toBe("Squadra 2");
  });

  it("dà precedenza a un override manuale", () => {
    expect(resolveSlot(2, 0, "B", defaultTeams(8), {}, { "2-0-B": "Ripescata" })).toBe("Ripescata");
  });

  it("accetta solo punteggi interi e non negativi", () => {
    expect(winnerFromScore(3, 2)).toBe("A");
    expect(winnerFromScore(2, 2)).toBeNull();
    expect(winnerFromScore(-1, 0)).toBeNull();
    expect(winnerFromScore(1.5, 1)).toBeNull();
  });
});
