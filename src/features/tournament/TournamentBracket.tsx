import { useState } from "react";
import { Card } from "../../components/ui/Card";
import { RoleLogin } from "../auth/RoleLogin";
import { useAuth } from "../auth/AuthContext";
import { MatchCard } from "./MatchCard";
import {
  BRACKET_SIZES,
  type BracketSize,
  type MatchesMap,
  type OverridesMap,
  type Side,
  matchKey,
  totalRounds,
  matchesInRound,
  defaultTeams,
  roundLabel,
  resolveSlot,
} from "./bracketUtils";

/*
  Torneo a tabellone — a eliminazione diretta, dimensione scelta tra
  8/16/32/64 squadre. Ruolo separato da quello staff (vedi AuthContext
  + supabase/schema.sql): chi gestisce il torneo NON può pubblicare
  annunci, e viceversa — due permessi distinti sullo stesso account
  Supabase Auth, decisi dalla colonna "role" in profiles.

  RIPESCAGGIO: non è un bottone dedicato con una regola fissa (tipo
  "sempre il miglior perdente") — è la matita (✎) su QUALSIASI slot,
  in QUALSIASI turno: la usi per far comparire lì una squadra diversa
  da quella che ci sarebbe arrivata vincendo. Più flessibile di una
  regola rigida, e con lo stesso gesto correggi anche un errore di
  battitura o un turno segnato per sbaglio.

  STATO ATTUALE: tutto qui vive in useState, solo nel browser di chi
  lo sta guardando in quel momento — non ancora salvato su Supabase,
  quindi non sincronizzato tra dispositivi diversi né visibile ai
  partecipanti da un altro telefono. È il prossimo pezzo naturale
  (stesso pattern degli annunci: fetch + realtime), lo segnaliamo qui
  per non lasciarlo capire per sbaglio.
*/
export function TournamentBracket() {
  const { role } = useAuth();
  const canEdit = role === "tournament_manager" || role === "admin";
  const matchHeight = 116;
  const matchGap = 32;

  const [size, setSize] = useState<BracketSize>(8);
  const [teams, setTeams] = useState<string[]>(defaultTeams(8));
  const [matches, setMatches] = useState<MatchesMap>({});
  const [overrides, setOverrides] = useState<OverridesMap>({});
  const [editingTeams, setEditingTeams] = useState(true);

  const rounds = totalRounds(size);
  const firstRoundMatches = matchesInRound(size, 0);
  const matchStep = matchHeight + matchGap;
  const bracketHeight = firstRoundMatches * matchHeight + (firstRoundMatches - 1) * matchGap;

  function changeSize(newSize: BracketSize) {
    setSize(newSize);
    setTeams(defaultTeams(newSize));
    setMatches({});
    setOverrides({});
  }

  function setWinner(round: number, index: number, side: Side) {
    const key = matchKey(round, index);
    setMatches((prev) => ({
      ...prev,
      [key]: {
        winner: side,
        scoreA: prev[key]?.scoreA ?? null,
        scoreB: prev[key]?.scoreB ?? null,
      },
    }));
  }

  function setScore(round: number, index: number, side: Side, value: number | null) {
    const key = matchKey(round, index);
    setMatches((prev) => {
      const current = prev[key] ?? { winner: null, scoreA: null, scoreB: null };
      return {
        ...prev,
        [key]: {
          ...current,
          scoreA: side === "A" ? value : current.scoreA,
          scoreB: side === "B" ? value : current.scoreB,
        },
      };
    });
  }

  function setOverride(round: number, index: number, side: Side, name: string) {
    const key = `${round}-${index}-${side}`;
    setOverrides((prev) => {
      const next = { ...prev };
      if (name.trim()) next[key] = name.trim();
      else delete next[key];
      return next;
    });
  }

  return (
    <section id="tornei" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Torneo a tabellone</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Eliminazione diretta — dimensione configurabile, con ripescaggio manuale.
      </p>

      <RoleLogin requiredRole="tournament_manager" label="Gestione tornei" />

      {!canEdit && (
        <p className="mb-4 rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-3 text-xs text-[var(--text-secondary)]">
          Tabellone in sola lettura — accedi come "Gestione tornei" per modificarlo.
        </p>
      )}

      {canEdit && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-[var(--text-secondary)]">Squadre:</span>
            {BRACKET_SIZES.map((s) => (
              <button
                key={s}
                onClick={() => changeSize(s)}
                className={`rounded-[var(--radius-pill)] border px-3 py-1 text-sm transition-colors ${
                  size === s
                    ? "border-[var(--accent-primary)] text-[var(--accent-primary)]"
                    : "border-[var(--surface-border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {s}
              </button>
            ))}
            <button
              onClick={() => setEditingTeams((v) => !v)}
              className="ml-auto text-xs text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--accent-primary)] hover:underline"
            >
              {editingTeams ? "Chiudi" : "Nomi squadre"}
            </button>
          </div>

          {editingTeams && (
            <Card className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {teams.map((t, i) => (
                <input
                  key={i}
                  aria-label={`Nome squadra ${i + 1}`}
                  value={t}
                  onChange={(e) => {
                    const next = [...teams];
                    next[i] = e.target.value;
                    setTeams(next);
                  }}
                  className="field"
                />
              ))}
            </Card>
          )}
        </>
      )}

      <div className="max-h-[75vh] overflow-auto pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex min-w-max gap-6 pr-4">
        {Array.from({ length: rounds }, (_, round) => (
          <div
            key={round}
            className={`relative w-56 flex-shrink-0 ${
              round < rounds - 1
                ? "after:absolute after:-right-3 after:top-0 after:h-full after:border-r after:border-[var(--surface-border)]"
                : ""
            }`}
          >
            <h3 className="mb-1 text-center font-display text-sm text-[var(--accent-primary)]">
              {roundLabel(size, round)}
            </h3>
            <div className="relative" style={{ height: bracketHeight }}>
            {Array.from({ length: matchesInRound(size, round) }, (_, index) => {
              const nameA = resolveSlot(round, index, "A", teams, matches, overrides);
              const nameB = resolveSlot(round, index, "B", teams, matches, overrides);
              const state = matches[matchKey(round, index)];
              const groupSize = 2 ** round;
              const top = (index * groupSize + (groupSize - 1) / 2) * matchStep;
              return (
                <div
                  key={index}
                  className="absolute inset-x-0"
                  style={{ top, height: matchHeight }}
                >
                  <MatchCard
                    nameA={nameA}
                    nameB={nameB}
                    scoreA={state?.scoreA ?? null}
                    scoreB={state?.scoreB ?? null}
                    winner={state?.winner ?? null}
                    editable={canEdit}
                    onSetWinner={(side) => setWinner(round, index, side)}
                    onSetScore={(side, value) => setScore(round, index, side, value)}
                    onOverride={(side, name) => setOverride(round, index, side, name)}
                  />
                </div>
              );
            })}
            </div>
          </div>
        ))}
        </div>
      </div>
    </section>
  );
}
