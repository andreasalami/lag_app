import { useEffect, useState } from "react";
import { Card } from "../../components/ui/Card";
import { SaveBanner } from "../../components/ui/SaveBanner";
import { useAuth } from "../auth/AuthContext";
import { isSupabaseConfigured, supabase } from "../../lib/supabaseClient";
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
  winnerFromScore,
} from "./bracketUtils";

type TournamentSnapshot = {
  size: BracketSize;
  teams: string[];
  matches: MatchesMap;
  overrides: OverridesMap;
};

const EMPTY_SNAPSHOT: TournamentSnapshot = { size: 8, teams: defaultTeams(8), matches: {}, overrides: {} };

// Bozza di lavoro di chi gestisce il torneo: sempre e solo in questo
// browser, mai su Supabase finché non premi "Pubblica". Sopravvive a
// refresh, crash del tab, chiusura accidentale — è la rete di
// sicurezza per il lavoro in corso, non per la condivisione tra
// dispositivi (per quella serve pubblicare).
const DRAFT_KEY = "lag-tournament-draft";
// Ogni quanto chi guarda (non gestisce) ricontrolla se c'è un turno
// nuovo pubblicato. Un tabellone eliminazione diretta non ha bisogno
// del millisecondo — 30s è un compromesso leggero, e a differenza di
// una connessione realtime non ha nessun tetto di concorrenza: che
// siano 10 o 3000 persone a guardare, è comunque solo una select su
// una riga sola ogni 30s a testa, sospesa quando il tab non è visibile.
const POLL_INTERVAL_MS = 30_000;

function parseSnapshot(value: unknown): TournamentSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TournamentSnapshot>;
  if (!BRACKET_SIZES.includes(candidate.size as BracketSize)) return null;
  if (!Array.isArray(candidate.teams) || candidate.teams.length !== candidate.size
    || candidate.teams.some((team) => typeof team !== "string" || team.length > 100)) return null;
  if (!candidate.matches || typeof candidate.matches !== "object" || Array.isArray(candidate.matches)) return null;
  if (!candidate.overrides || typeof candidate.overrides !== "object" || Array.isArray(candidate.overrides)) return null;
  return candidate as TournamentSnapshot;
}

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

  PERSISTENZA A DUE LIVELLI, deliberata:
  - Chi gestisce (canEdit) lavora su una bozza locale (localStorage):
    ogni tocco è salvato lì all'istante, zero rete, sopravvive a un
    refresh o a un crash del browser. Il DB non viene toccato ad ogni
    punteggio segnato — solo quando premi "Pubblica".
  - Chi guarda (!canEdit) non ha mai una bozza: legge solo l'ultimo
    stato pubblicato su Supabase, via polling (non realtime — vedi il
    commento sopra tournament_state in schema.sql sul perché).

  Cambiare dispositivo a metà torneo funziona SOLO se hai premuto
  Pubblica prima di cambiare: il device nuovo riparte dall'ultimo
  pubblicato, non da quello che avevi scritto e non ancora mandato.
  Da qui l'avviso beforeunload quando ci sono modifiche in sospeso.
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

  const [savedSnapshot, setSavedSnapshot] = useState<TournamentSnapshot | null>(null);
  const [hydratedMode, setHydratedMode] = useState<boolean | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [showCloseWarning, setShowCloseWarning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Caricamento iniziale: per l'editor, la bozza locale (se esiste)
  // vince sull'ultimo pubblicato, perché rappresenta lavoro più
  // recente di quando hai premuto Pubblica l'ultima volta. Per chi
  // guarda, invece, niente bozza: solo l'ultimo pubblicato.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!isSupabaseConfigured) {
        setSavedSnapshot(EMPTY_SNAPSHOT);
        setSize(EMPTY_SNAPSHOT.size);
        setTeams(EMPTY_SNAPSHOT.teams);
        setMatches(EMPTY_SNAPSHOT.matches);
        setOverrides(EMPTY_SNAPSHOT.overrides);
        setHydratedMode(canEdit);
        return;
      }

      const { data, error } = await supabase.from("tournament_state").select("size, teams, matches, overrides").eq("id", "main").maybeSingle();
      if (cancelled) return;

      const published = parseSnapshot(data) ?? EMPTY_SNAPSHOT;
      setLoadError(error ? "Tabellone non disponibile. Riprova più tardi." : null);
      setSavedSnapshot(published);
      if (!error) setLastSyncedAt(new Date());

      let starting = published;
      if (canEdit) {
        try {
          const draftRaw = localStorage.getItem(DRAFT_KEY);
          if (draftRaw) {
            starting = parseSnapshot(JSON.parse(draftRaw)) ?? published;
          }
        } catch {
          // Storage disabilitato o bozza corrotta: riparti dal pubblicato.
        }
      }
      setSize(starting.size);
      setTeams(starting.teams);
      setMatches(starting.matches);
      setOverrides(starting.overrides);
      setHydratedMode(canEdit);
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit]);

  // Polling SOLO per chi guarda: ricontrolla l'ultimo pubblicato ogni
  // POLL_INTERVAL_MS. Chi edita non fa polling — scriverebbe sopra il
  // proprio lavoro in corso con l'ultimo dato pubblicato, cancellando
  // di fatto le modifiche non ancora inviate.
  useEffect(() => {
    if (canEdit || !isSupabaseConfigured) return;

    async function refreshPublished() {
      if (document.visibilityState !== "visible") return;
      const { data, error } = await supabase.from("tournament_state").select("size, teams, matches, overrides").eq("id", "main").maybeSingle();
      const snapshot = parseSnapshot(data);
      if (error || !snapshot) return;
      setSize(snapshot.size);
      setTeams(snapshot.teams);
      setMatches(snapshot.matches);
      setOverrides(snapshot.overrides);
      setLastSyncedAt(new Date());
    }

    const interval = window.setInterval(() => void refreshPublished(), POLL_INTERVAL_MS);
    const handleVisibility = () => void refreshPublished();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [canEdit]);

  // Auto-salvataggio della bozza locale ad ogni modifica — solo
  // dopo l'hydration iniziale, altrimenti sovrascriveresti una bozza
  // buona con lo stato-zero di partenza del render prima ancora di
  // averla letta.
  useEffect(() => {
    if (!canEdit || hydratedMode !== canEdit) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ size, teams, matches, overrides }));
    } catch {
      setPublishError("Bozza locale non disponibile: salva prima di chiudere la pagina.");
    }
  }, [canEdit, hydratedMode, size, teams, matches, overrides]);

  const isDirty =
    canEdit &&
    savedSnapshot !== null &&
    JSON.stringify({ size, teams, matches, overrides }) !== JSON.stringify(savedSnapshot);

  // Avviso del browser se provi a chiudere/ricaricare con modifiche
  // non ancora pubblicate — la rete di sicurezza per non perderle
  // cambiando device senza accorgertene.
  useEffect(() => {
    if (!isDirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  async function handlePublish(): Promise<boolean> {
    setPublishing(true);
    setPublishError(null);
    const { error } = await supabase
      .from("tournament_state")
      .upsert({ id: "main", size, teams, matches, overrides, updated_at: new Date().toISOString() }, { onConflict: "id" });

    if (error) {
      console.error("[Torneo] Errore pubblicazione:", error.message);
      setPublishError("Pubblicazione non riuscita. Riprova.");
      setPublishing(false);
      return false;
    }
    setSavedSnapshot({ size, teams, matches, overrides });
    setLastSyncedAt(new Date());
    setPublishing(false);
    return true;
  }

  // Chiudere il pannello nomi squadre con modifiche in sospeso è
  // esattamente il momento in cui si rischia di cambiare dispositivo
  // (o aspettarsi che il tabellone sia aggiornato per il pubblico)
  // senza aver pubblicato: da qui l'avviso invece del toggle diretto.
  function handleCloseClick() {
    if (editingTeams && isDirty) {
      setShowCloseWarning(true);
      return;
    }
    setEditingTeams((v) => !v);
  }

  async function handlePublishAndClose() {
    const published = await handlePublish();
    if (!published) return;
    setShowCloseWarning(false);
    setEditingTeams(false);
  }

  function handleCloseWithoutSaving() {
    setShowCloseWarning(false);
    setEditingTeams(false);
  }

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

  function setScore(round: number, index: number, side: Side, value: number | null) {
    const key = matchKey(round, index);
    setMatches((prev) => {
      const current = prev[key] ?? { winner: null, scoreA: null, scoreB: null };
      const scoreA = side === "A" ? value : current.scoreA;
      const scoreB = side === "B" ? value : current.scoreB;
      return {
        ...prev,
        [key]: {
          ...current,
          winner: winnerFromScore(scoreA, scoreB),
          scoreA,
          scoreB,
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

      {loadError && <p className="mb-4 text-sm text-[var(--state-error)]">{loadError}</p>}

      {!canEdit && (
        <p className="mb-4 rounded-[var(--radius-md)] border border-dashed border-[var(--surface-border)] p-3 text-xs text-[var(--text-secondary)]">
          Tabellone in sola lettura — accedi come "Gestione tornei" per modificarlo.
          {lastSyncedAt && ` Aggiornato alle ${lastSyncedAt.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}.`}
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
              onClick={handleCloseClick}
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

      {/* Stesso banner condiviso di Programma e Menu (vedi SaveBanner.tsx):
          l'etichetta del bottone è "Salva" ovunque nell'app per coerenza,
          il messaggio resta specifico del Torneo perché qui "salvare"
          vuol dire pubblicare — chi guarda vede il tabellone solo dopo. */}
      {canEdit && isDirty && (
        <SaveBanner
          message="Ci sono modifiche al Torneo non ancora salvate — chi guarda vede ancora l'ultimo turno pubblicato."
          saving={publishing}
          error={publishError}
          onSave={handlePublish}
        />
      )}

      {showCloseWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="glass-elevated glass-elevated--strong w-full max-w-sm rounded-[var(--radius-md)] border border-[var(--state-error)] p-5">
            <p className="mb-1 text-sm font-semibold text-[var(--state-error)]">⚠ Modifiche non pubblicate</p>
            <p className="mb-4 text-sm text-[var(--text-secondary)]">
              Hai punteggi o nomi non ancora pubblicati. Se cambi dispositivo o serve che il pubblico veda il
              tabellone aggiornato, devi pubblicare ora — altrimenti restano solo su questo browser.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCloseWithoutSaving}
                className="rounded-[var(--radius-pill)] border border-[var(--surface-border)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Chiudi senza pubblicare
              </button>
              <button
                onClick={handlePublishAndClose}
                disabled={publishing}
                className="signature-glow rounded-[var(--radius-pill)] bg-[var(--accent-primary)] px-4 py-1.5 text-xs font-semibold text-[var(--text-on-accent)] disabled:opacity-50"
              >
                {publishing ? "Salvo..." : "Salva ora"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
