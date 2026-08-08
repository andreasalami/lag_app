export type BracketSize = 8 | 16 | 32 | 64;
export type Side = "A" | "B";

export interface MatchState {
  winner: Side | null;
  scoreA: number | null;
  scoreB: number | null;
}

export type MatchesMap = Record<string, MatchState>; // key: `${round}-${index}`
export type OverridesMap = Record<string, string>; // key: `${round}-${index}-${side}`

export const BRACKET_SIZES: BracketSize[] = [8, 16, 32, 64];

export function matchKey(round: number, index: number): string {
  return `${round}-${index}`;
}

export function slotKey(round: number, index: number, side: Side): string {
  return `${round}-${index}-${side}`;
}

export function totalRounds(size: BracketSize): number {
  return Math.log2(size);
}

export function matchesInRound(size: BracketSize, round: number): number {
  return size / Math.pow(2, round + 1);
}

export function defaultTeams(size: BracketSize): string[] {
  return Array.from({ length: size }, (_, i) => `Squadra ${i + 1}`);
}

export function roundLabel(size: BracketSize, round: number): string {
  const teamsEnteringRound = matchesInRound(size, round) * 2;
  if (teamsEnteringRound === 2) return "Finale";
  if (teamsEnteringRound === 4) return "Semifinale";
  if (teamsEnteringRound === 8) return "Quarti di finale";
  return `Turno da ${teamsEnteringRound}`;
}

export function winnerFromScore(scoreA: number | null, scoreB: number | null): Side | null {
  if (scoreA === null || scoreB === null || scoreA === scoreB) return null;
  return scoreA > scoreB ? "A" : "B";
}

/**
 * Nome della squadra in un dato slot, risolto ricorsivamente:
 * 1. Se c'è un override manuale su questo slot (ripescaggio o
 *    correzione), vince quello — a prescindere da tutto il resto.
 * 2. Al round 0, viene dalla lista squadre iniziale.
 * 3. Ai round successivi, viene dal vincitore del match corrispondente
 *    nel round precedente (se non è ancora stato deciso, torna null
 *    = "in attesa").
 *
 * Questo disegno (derivare tutto invece di "spingere" i vincitori in
 * avanti manualmente) è quello che fa funzionare il ripescaggio senza
 * bisogno di logica di cascata a parte: cambi un override in un punto
 * qualsiasi del tabellone, tutto quello che dipende da lì si ricalcola
 * da solo al prossimo render.
 */
export function resolveSlot(
  round: number,
  index: number,
  side: Side,
  teams: string[],
  matches: MatchesMap,
  overrides: OverridesMap
): string | null {
  const override = overrides[slotKey(round, index, side)];
  if (override) return override;

  if (round === 0) {
    const teamIndex = index * 2 + (side === "A" ? 0 : 1);
    return teams[teamIndex] ?? null;
  }

  const prevIndex = side === "A" ? index * 2 : index * 2 + 1;
  const prevWinnerSide = matches[matchKey(round - 1, prevIndex)]?.winner;
  if (!prevWinnerSide) return null;
  return resolveSlot(round - 1, prevIndex, prevWinnerSide, teams, matches, overrides);
}
