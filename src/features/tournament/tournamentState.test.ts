import { describe, expect, it } from "vitest";
import {
  mergeTournament,
  parseTournamentSave,
  parseTournamentSnapshot,
  sameTournament,
  teamNameTooLong,
} from "./tournamentState";

const snapshot = {
  size: 8 as const,
  teams: Array.from({ length: 8 }, (_, index) => `Squadra ${index + 1}`),
  matches: {},
  overrides: {},
};

describe("tournament state", () => {
  it("valida uno snapshot coerente con la dimensione", () => {
    expect(parseTournamentSnapshot(snapshot)).toEqual(snapshot);
    expect(parseTournamentSnapshot({ ...snapshot, teams: snapshot.teams.slice(0, 7) })).toBeNull();
  });

  it("limita a 20 caratteri i nomi da pubblicare", () => {
    expect(teamNameTooLong("A".repeat(20))).toBe(false);
    expect(teamNameTooLong("A".repeat(21))).toBe(true);
  });

  it("mostra al pubblico anche un torneo già pubblicato con nomi oltre il limite", () => {
    const teams = [...snapshot.teams];
    teams[0] = "Nome già pubblicato molto più lungo";
    expect(parseTournamentSnapshot({ ...snapshot, teams })?.teams[0]).toBe(teams[0]);
  });

  it("converte una riga salvataggio Supabase e rifiuta metadati mancanti", () => {
    const row = { ...snapshot, id: "save-1", name: "Finale", updated_at: "2026-10-06 18:00:00.123456+00" };
    expect(parseTournamentSave(row)).toEqual({
      ...snapshot,
      id: "save-1",
      name: "Finale",
      updatedAt: "2026-10-06 18:00:00.123456+00",
    });
    expect(parseTournamentSave({ ...row, name: undefined })).toBeNull();
  });

  it("confronta i tabelloni ignorando l'ordine delle chiavi del database", () => {
    const local = { ...snapshot, matches: { "0-0": { winner: "A" as const, scoreA: 2, scoreB: 1 } } };
    const fromDatabase = { ...snapshot, matches: { "0-0": { scoreA: 2, scoreB: 1, winner: "A" as const } } };
    expect(sameTournament(local, fromDatabase)).toBe(true);
    expect(sameTournament(local, snapshot)).toBe(false);
  });
});

describe("mergeTournament", () => {
  const match = (scoreA: number, scoreB: number) => ({
    winner: scoreA > scoreB ? ("A" as const) : ("B" as const),
    scoreA,
    scoreB,
  });

  it("tiene le modifiche di due postazioni su partite, squadre e ripescaggi diversi", () => {
    const mine = { ...snapshot, matches: { "0-0": match(2, 1) }, overrides: { "1-0-A": "Ripescata" } };
    const theirs = {
      ...snapshot,
      teams: ["Leoni", ...snapshot.teams.slice(1)],
      matches: { "0-1": match(0, 3) },
    };
    expect(mergeTournament(snapshot, mine, theirs)).toEqual({
      size: 8,
      teams: theirs.teams,
      matches: { "0-0": match(2, 1), "0-1": match(0, 3) },
      overrides: { "1-0-A": "Ripescata" },
    });
  });

  it("sulla stessa partita vale la mia modifica, e una cancellazione altrui resta cancellata", () => {
    const base = { ...snapshot, matches: { "0-0": match(1, 0), "0-1": match(1, 0) } };
    const mine = { ...base, matches: { "0-0": match(5, 0), "0-1": match(1, 0) } };
    const theirs = { ...base, matches: { "0-0": match(0, 9) } };
    expect(mergeTournament(base, mine, theirs)?.matches).toEqual({ "0-0": match(5, 0) });
  });

  it("non fonde tabelloni di dimensioni diverse", () => {
    const bigger = { ...snapshot, size: 16 as const, teams: [...snapshot.teams, ...snapshot.teams] };
    expect(mergeTournament(snapshot, snapshot, bigger)).toBeNull();
  });
});
