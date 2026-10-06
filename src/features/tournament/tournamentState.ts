import { supabase } from "../../lib/supabaseClient";
import { BRACKET_SIZES, defaultTeams, type BracketSize, type MatchesMap, type OverridesMap } from "./bracketUtils";

export type TournamentSnapshot = {
  size: BracketSize;
  teams: string[];
  matches: MatchesMap;
  overrides: OverridesMap;
};

/** Versione del tabellone salvata da chi gestisce; `updatedAt` resta il testo esatto del database. */
export type TournamentSave = TournamentSnapshot & {
  id: string;
  name: string;
  updatedAt: string;
};

// Limite per scrivere e pubblicare: le card del tabellone sono strette.
// La lettura resta tollerante (100) così dati già pubblicati più lunghi
// non nascondono l'intero torneo al pubblico.
export const TEAM_NAME_MAX_LENGTH = 20;
const STORED_TEAM_NAME_MAX_LENGTH = 100;

export function teamNameTooLong(name: string) {
  return name.length > TEAM_NAME_MAX_LENGTH;
}

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
  if (
    !Array.isArray(candidate.teams) ||
    candidate.teams.length !== candidate.size ||
    candidate.teams.some((team) => typeof team !== "string" || team.length > STORED_TEAM_NAME_MAX_LENGTH)
  )
    return null;
  if (!candidate.matches || typeof candidate.matches !== "object" || Array.isArray(candidate.matches)) return null;
  if (!candidate.overrides || typeof candidate.overrides !== "object" || Array.isArray(candidate.overrides))
    return null;

  const matchesAreValid = Object.values(candidate.matches).every((match) => {
    if (!match || typeof match !== "object") return false;
    const state = match as MatchesMap[string];
    return (
      (state.winner === null || state.winner === "A" || state.winner === "B") &&
      validScore(state.scoreA) &&
      validScore(state.scoreB) &&
      (state.completedAt === undefined ||
        state.completedAt === null ||
        (typeof state.completedAt === "string" && !Number.isNaN(Date.parse(state.completedAt))))
    );
  });
  if (!matchesAreValid) return null;

  return {
    size: candidate.size as BracketSize,
    teams: candidate.teams,
    matches: candidate.matches,
    overrides: candidate.overrides,
  };
}

export function parseTournamentSave(value: unknown): TournamentSave | null {
  const snapshot = parseTournamentSnapshot(value);
  if (!snapshot || !value || typeof value !== "object") return null;
  const candidate = value as { id?: unknown; name?: unknown; updated_at?: unknown };
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  if (typeof candidate.name !== "string" || typeof candidate.updated_at !== "string") return null;
  return { ...snapshot, id: candidate.id, name: candidate.name, updatedAt: candidate.updated_at };
}

// Il database riordina le chiavi degli oggetti JSON: il confronto deve ignorare l'ordine.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

export function sameTournament(a: TournamentSnapshot, b: TournamentSnapshot) {
  const pick = ({ size, teams, matches, overrides }: TournamentSnapshot) => ({ size, teams, matches, overrides });
  return JSON.stringify(canonical(pick(a))) === JSON.stringify(canonical(pick(b)));
}

/** Salvataggi del torneo (solo gestori) e quale di questi è in onda. */
export async function fetchTournamentSaves() {
  const [list, state] = await Promise.all([
    supabase
      .from("tournament_snapshots")
      .select("id, name, size, teams, matches, overrides, updated_at")
      .order("updated_at", { ascending: false }),
    supabase.from("tournament_state").select("live_save_id").eq("id", "main").maybeSingle(),
  ]);
  const liveId: unknown = state.data?.live_save_id;
  return {
    error: list.error ?? state.error,
    saves: (list.data ?? []).flatMap((row: unknown) => {
      const save = parseTournamentSave(row);
      return save ? [save] : [];
    }),
    liveId: typeof liveId === "string" ? liveId : null,
  };
}

const PUBLISHED_COLUMNS = "size, teams, matches, overrides, revision";
const revisionOf = (row: { revision?: unknown } | null) => (typeof row?.revision === "number" ? row.revision : null);

/** Ultimo tabellone pubblicato; `snapshot` è null se la riga manca o non è valida. */
export async function fetchPublishedTournament() {
  const { data, error } = await supabase
    .from("tournament_state")
    .select(PUBLISHED_COLUMNS)
    .eq("id", "main")
    .maybeSingle();
  return { error, snapshot: parseTournamentSnapshot(data), revision: revisionOf(data) };
}

/** Solo la revisione: controllo leggero per riscaricare il tabellone soltanto quando cambia. */
export async function fetchPublishedRevision() {
  const { data, error } = await supabase.from("tournament_state").select("revision").eq("id", "main").maybeSingle();
  return { error, revision: revisionOf(data) };
}
