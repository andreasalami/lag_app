import {
  BRACKET_SIZES,
  defaultTeams,
  type BracketSize,
  type MatchesMap,
  type OverridesMap,
} from "./bracketUtils";

export type TournamentSnapshot = {
  size: BracketSize;
  teams: string[];
  matches: MatchesMap;
  overrides: OverridesMap;
};

export type TournamentArchive = TournamentSnapshot & {
  id: string;
  reason: "size_change" | "restore";
  targetSize: BracketSize | null;
  createdAt: string;
};

export const EMPTY_TOURNAMENT_SNAPSHOT: TournamentSnapshot = {
  size: 8,
  teams: defaultTeams(8),
  matches: {},
  overrides: {},
};

function validScore(value: unknown) {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999);
}

export function parseTournamentSnapshot(value: unknown): TournamentSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TournamentSnapshot>;
  if (!BRACKET_SIZES.includes(candidate.size as BracketSize)) return null;
  if (!Array.isArray(candidate.teams) || candidate.teams.length !== candidate.size
    || candidate.teams.some((team) => typeof team !== "string" || team.length > 100)) return null;
  if (!candidate.matches || typeof candidate.matches !== "object" || Array.isArray(candidate.matches)) return null;
  if (!candidate.overrides || typeof candidate.overrides !== "object" || Array.isArray(candidate.overrides)) return null;

  const matchesAreValid = Object.values(candidate.matches).every((match) => {
    if (!match || typeof match !== "object") return false;
    const state = match as MatchesMap[string];
    return (state.winner === null || state.winner === "A" || state.winner === "B")
      && validScore(state.scoreA)
      && validScore(state.scoreB)
      && (state.completedAt === undefined || state.completedAt === null
        || (typeof state.completedAt === "string" && !Number.isNaN(Date.parse(state.completedAt))));
  });
  if (!matchesAreValid) return null;

  return {
    size: candidate.size as BracketSize,
    teams: candidate.teams,
    matches: candidate.matches,
    overrides: candidate.overrides,
  };
}

export function parseTournamentArchive(value: unknown): TournamentArchive | null {
  const snapshot = parseTournamentSnapshot(value);
  if (!snapshot || !value || typeof value !== "object") return null;
  const candidate = value as {
    id?: unknown;
    reason?: unknown;
    target_size?: unknown;
    created_at?: unknown;
  };
  const targetSize = candidate.target_size === null
    ? null
    : BRACKET_SIZES.includes(candidate.target_size as BracketSize)
      ? candidate.target_size as BracketSize
      : undefined;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  if (candidate.reason !== "size_change" && candidate.reason !== "restore") return null;
  if (targetSize === undefined) return null;
  if (typeof candidate.created_at !== "string" || Number.isNaN(Date.parse(candidate.created_at))) return null;
  return {
    ...snapshot,
    id: candidate.id,
    reason: candidate.reason,
    targetSize,
    createdAt: candidate.created_at,
  };
}
