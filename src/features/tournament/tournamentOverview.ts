import {
  matchKey,
  matchesInRound,
  resolveSlot,
  roundLabel,
  totalRounds,
  type Side,
} from "./bracketUtils";
import type { TournamentSnapshot } from "./tournamentState";

export type TournamentResult = {
  key: string;
  round: number;
  roundLabel: string;
  teamA: string;
  teamB: string;
  scoreA: number;
  scoreB: number;
  winner: Side;
  completedAt: string | null;
};

export function currentRoundLabel(snapshot: TournamentSnapshot) {
  const rounds = totalRounds(snapshot.size);
  for (let round = 0; round < rounds; round += 1) {
    const complete = Array.from({ length: matchesInRound(snapshot.size, round) }, (_, index) =>
      snapshot.matches[matchKey(round, index)]?.winner != null).every(Boolean);
    if (!complete) return roundLabel(snapshot.size, round);
  }
  return "Torneo concluso";
}

export function latestTournamentResults(snapshot: TournamentSnapshot, limit = 5): TournamentResult[] {
  const results: TournamentResult[] = [];
  const rounds = totalRounds(snapshot.size);

  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < matchesInRound(snapshot.size, round); index += 1) {
      const key = matchKey(round, index);
      const match = snapshot.matches[key];
      if (!match?.winner || match.scoreA === null || match.scoreB === null) continue;
      const teamA = resolveSlot(round, index, "A", snapshot.teams, snapshot.matches, snapshot.overrides);
      const teamB = resolveSlot(round, index, "B", snapshot.teams, snapshot.matches, snapshot.overrides);
      if (!teamA || !teamB) continue;
      results.push({
        key,
        round,
        roundLabel: roundLabel(snapshot.size, round),
        teamA,
        teamB,
        scoreA: match.scoreA,
        scoreB: match.scoreB,
        winner: match.winner,
        completedAt: match.completedAt ?? null,
      });
    }
  }

  return results
    .sort((a, b) => {
      const timeA = a.completedAt ? Date.parse(a.completedAt) : 0;
      const timeB = b.completedAt ? Date.parse(b.completedAt) : 0;
      if (timeA !== timeB) return timeB - timeA;
      if (a.round !== b.round) return b.round - a.round;
      return b.key.localeCompare(a.key);
    })
    .slice(0, limit);
}
