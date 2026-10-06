import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { StaffPanel } from "../../components/ui/StaffPanel";
import { useAuth } from "../auth/AuthContext";
import { TournamentBroadcast } from "./TournamentBroadcast";
import { isSupabaseConfigured, supabase } from "../../lib/supabaseClient";
import { MatchCard } from "./MatchCard";
import { pollWhileVisible } from "../../lib/browser";
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
  isUntouchedBracket,
  roundLabel,
  resolveSlot,
  slotKey,
  winnerFromScore,
} from "./bracketUtils";
import {
  EMPTY_TOURNAMENT_SNAPSHOT,
  fetchPublishedRevision,
  fetchPublishedTournament,
  fetchTournamentSaves,
  parseTournamentSnapshot,
  sameTournament,
  TEAM_NAME_MAX_LENGTH,
  teamNameTooLong,
  type TournamentSave,
  type TournamentSnapshot,
} from "./tournamentState";

// Modifiche non ancora salvate, solo in questo browser: se la pagina si ricarica per
// sbaglio a metà partita si riprendono da qui, sul salvataggio da cui erano partite.
const DRAFT_KEY = "lag-tournament-draft";
// Ogni quanto chi guarda (non gestisce) ricontrolla se c'è un turno
// nuovo pubblicato. Un tabellone eliminazione diretta non ha bisogno
// del millisecondo — 30s è un compromesso leggero, e a differenza di
// una connessione realtime non ha nessun tetto di concorrenza: che
// siano 10 o 3000 persone a guardare, è comunque solo una select su
// una riga sola ogni 30s a testa, sospesa quando il tab non è visibile.
const POLL_INTERVAL_MS = 30_000;
const SAVE_NAME_MAX_LENGTH = 60;

const formatDate = (value: string) =>
  new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });

function readDraft(key: string) {
  try {
    const draft = JSON.parse(localStorage.getItem(key) ?? "null") as { saveId?: unknown } | null;
    const snapshot = parseTournamentSnapshot(draft);
    return snapshot && typeof draft?.saveId === "string" ? { ...snapshot, saveId: draft.saveId } : null;
  } catch {
    return null; // Storage disabilitato o bozza corrotta: si riparte dal salvataggio.
  }
}

/*
  Torneo a tabellone — a eliminazione diretta, dimensione scelta tra
  8/16/32/64 squadre. Ruolo separato da quello staff (vedi AuthContext
  + supabase/schema.sql), deciso dalla colonna "role" in profiles.

  RIPESCAGGIO: non è un bottone dedicato con una regola fissa (tipo
  "sempre il miglior perdente") — è la matita (✎) su QUALSIASI slot,
  in QUALSIASI turno: la usi per far comparire lì una squadra diversa
  da quella che ci sarebbe arrivata vincendo. Più flessibile di una
  regola rigida, e con lo stesso gesto correggi anche un errore di
  battitura o un turno segnato per sbaglio.

  SALVATAGGI: chi gestisce lavora su un salvataggio scelto dall'elenco
  (tournament_snapshots). Le modifiche restano nell'editor finché non
  preme "Salva modifiche"; uno solo dei salvataggi è "in onda" e salvarlo
  aggiorna anche il tabellone pubblico (RPC save_tournament). Gli altri
  restano privati finché non vengono messi in onda.

  Chi guarda (!canEdit) legge solo l'ultimo stato pubblicato, via
  polling (non realtime — vedi il commento sopra tournament_state in
  schema.sql sul perché).
*/
export function TournamentBracket({ management = false }: { management?: boolean }) {
  const { role, session } = useAuth();
  const draftKey = `${DRAFT_KEY}:${session?.user.id ?? "local"}`;
  const loadedDraftKey = useRef<string | null>(null);
  const canEdit = management && (role === "tournament_manager" || role === "admin");
  const matchHeight = 116;
  const matchGap = 32;

  const [size, setSize] = useState<BracketSize>(8);
  const [teams, setTeams] = useState<string[]>(defaultTeams(8));
  const [matches, setMatches] = useState<MatchesMap>({});
  const [overrides, setOverrides] = useState<OverridesMap>({});
  const [editingTeams, setEditingTeams] = useState(true);

  const [hydrated, setHydrated] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingSize, setPendingSize] = useState<BracketSize | null>(null);

  const [saves, setSaves] = useState<TournamentSave[]>([]);
  const [liveId, setLiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [newSaveName, setNewSaveName] = useState<string | null>(null);
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);

  const selected = saves.find((save) => save.id === selectedId) ?? null;
  const current: TournamentSnapshot = { size, teams, matches, overrides };

  function applySnapshot(snapshot: TournamentSnapshot) {
    setSize(snapshot.size);
    setTeams(snapshot.teams);
    setMatches(snapshot.matches);
    setOverrides(snapshot.overrides);
  }

  // Caricamento iniziale. Per chi gestisce: l'elenco dei salvataggi e, se c'è,
  // la bozza rimasta da una ricarica; altrimenti il salvataggio in onda.
  // Per chi guarda: solo l'ultimo pubblicato.
  useEffect(() => {
    let cancelled = false;
    loadedDraftKey.current = null;

    async function load() {
      if (!isSupabaseConfigured) {
        applySnapshot(EMPTY_TOURNAMENT_SNAPSHOT);
        setHydrated(true);
        return;
      }

      if (!canEdit) {
        const latest = await fetchPublishedTournament();
        if (cancelled) return;
        if (latest.error) {
          setLoadError("Tabellone non disponibile. Riprova tra poco.");
          return;
        }
        applySnapshot(latest.snapshot ?? EMPTY_TOURNAMENT_SNAPSHOT);
        setLastSyncedAt(new Date());
        setHydrated(true);
        return;
      }

      const list = await fetchTournamentSaves();
      if (cancelled) return;
      if (list.error) {
        setLoadError("Salvataggi del torneo non disponibili. Ricarica prima di modificare il torneo.");
        return;
      }
      const draft = readDraft(draftKey);
      const start =
        list.saves.find((save) => save.id === draft?.saveId) ??
        list.saves.find((save) => save.id === list.liveId) ??
        list.saves[0] ??
        null;
      setLoadError(null);
      setSaves(list.saves);
      setLiveId(list.liveId);
      setSelectedId(start?.id ?? null);
      applySnapshot(draft && draft.saveId === start?.id ? draft : (start ?? EMPTY_TOURNAMENT_SNAPSHOT));
      loadedDraftKey.current = draftKey;
      setHydrated(true);
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, draftKey]);

  // Polling SOLO per chi guarda: ricontrolla l'ultimo pubblicato ogni
  // POLL_INTERVAL_MS. Chi edita non fa polling — scriverebbe sopra il
  // proprio lavoro in corso con l'ultimo dato pubblicato, cancellando
  // di fatto le modifiche non ancora inviate.
  useEffect(() => {
    if (canEdit || !isSupabaseConfigured) return;

    let cancelled = false;
    let busy = false;
    let seenRevision: number | null = null;
    async function refreshPublished() {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const probe = await fetchPublishedRevision();
        if (cancelled || probe.error || (seenRevision !== null && probe.revision === seenRevision)) return;
        const { error, snapshot, revision } = await fetchPublishedTournament();
        if (cancelled || error || !snapshot) return;
        seenRevision = revision;
        applySnapshot(snapshot);
        setLastSyncedAt(new Date());
      } finally {
        busy = false;
      }
    }

    const stopPolling = pollWhileVisible(() => void refreshPublished(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [canEdit]);

  const isDirty = canEdit && hydrated && (selected ? !sameTournament(current, selected) : false);

  // La bozza esiste solo finché ci sono modifiche da salvare.
  useEffect(() => {
    if (!canEdit || loadedDraftKey.current !== draftKey) return;
    try {
      if (isDirty && selected) {
        localStorage.setItem(draftKey, JSON.stringify({ saveId: selected.id, size, teams, matches, overrides }));
      } else {
        localStorage.removeItem(draftKey);
      }
    } catch {
      // Senza memoria locale le modifiche restano solo nell'editor finché non si salva.
    }
  }, [canEdit, isDirty, selected, size, teams, matches, overrides, draftKey]);

  // I ripescaggi vengono salvati già senza spazi esterni (vedi setOverride).
  const hasTooLongNames = [...teams, ...Object.values(overrides)].some(teamNameTooLong);

  // Avviso del browser se provi a chiudere/ricaricare con modifiche non salvate.
  useEffect(() => {
    if (!isDirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  /** Salva sul salvataggio scelto, oppure ne crea uno nuovo con `asNew` come nome. */
  async function save({ asNew, publish = false }: { asNew?: string; publish?: boolean }) {
    if (hasTooLongNames || saving) return false;
    const target = asNew === undefined ? selected : null;
    setSaving(true);
    setSaveError(null);
    setSaveConflict(false);
    const { data, error } = await supabase.rpc("save_tournament", {
      p_id: target?.id ?? null,
      p_name: asNew ?? target?.name ?? "",
      p_expected_updated_at: target?.updatedAt ?? null,
      p_size: size,
      p_teams: teams,
      p_matches: matches,
      p_overrides: overrides,
      p_publish: publish,
    });
    setSaving(false);
    const row = data as { id?: unknown; name?: unknown; updated_at?: unknown; live?: unknown } | null;
    if (error || typeof row?.id !== "string" || typeof row.name !== "string" || typeof row.updated_at !== "string") {
      console.error("[Torneo] Salvataggio non riuscito:", error?.message);
      const conflict = Boolean(error?.message.includes("save_conflict"));
      setSaveConflict(conflict);
      setSaveError(
        conflict
          ? "Un’altra postazione ha salvato questo torneo nel frattempo. Ricaricalo per vedere la versione aggiornata: le tue modifiche andranno perse."
          : "Salvataggio non riuscito. Le modifiche sono ancora qui: riprova.",
      );
      return false;
    }
    // L'editor tiene i dati come li ha scritti: il confronto con sameTournament ignora l'ordine del database.
    const saved: TournamentSave = { ...current, id: row.id, name: row.name, updatedAt: row.updated_at };
    setSaves((list) => [saved, ...list.filter((item) => item.id !== saved.id)]);
    setSelectedId(saved.id);
    if (row.live === true) setLiveId(saved.id);
    return true;
  }

  async function reloadSaves(openId: string | null) {
    const list = await fetchTournamentSaves();
    if (list.error) {
      setSaveError("Salvataggi non disponibili. Controlla la connessione e riprova.");
      return;
    }
    setSaves(list.saves);
    setLiveId(list.liveId);
    const next = list.saves.find((item) => item.id === openId) ?? list.saves[0] ?? null;
    setSelectedId(next?.id ?? null);
    if (next) applySnapshot(next);
    setSaveError(null);
    setSaveConflict(false);
  }

  function openSave(id: string) {
    const next = saves.find((item) => item.id === id);
    if (!next) return;
    applySnapshot(next);
    setSelectedId(id);
    setSaveError(null);
    setSaveConflict(false);
    setPendingSelectId(null);
  }

  function requestOpenSave(id: string) {
    if (id === selectedId) return;
    if (isDirty) setPendingSelectId(id);
    else openSave(id);
  }

  async function confirmNewSave() {
    const name = newSaveName?.trim() ?? "";
    if (!name) return;
    if (await save({ asNew: name })) setNewSaveName(null);
  }

  const rounds = totalRounds(size);
  const firstRoundMatches = matchesInRound(size, 0);
  const matchStep = matchHeight + matchGap;
  const bracketHeight = firstRoundMatches * matchHeight + (firstRoundMatches - 1) * matchGap;

  function requestSizeChange(newSize: BracketSize) {
    if (newSize === size) return;
    // Senza nomi né risultati non c'è niente da perdere: si cambia subito, senza domande.
    if (isUntouchedBracket(size, teams, matches, overrides)) applySizeChange(newSize);
    else setPendingSize(newSize);
  }

  function applySizeChange(nextSize: BracketSize) {
    applySnapshot({ size: nextSize, teams: defaultTeams(nextSize), matches: {}, overrides: {} });
    setEditingTeams(true);
    setPendingSize(null);
  }

  function setScore(round: number, index: number, side: Side, value: number | null) {
    const key = matchKey(round, index);
    setMatches((prev) => {
      const current = prev[key] ?? { winner: null, scoreA: null, scoreB: null };
      const scoreA = side === "A" ? value : current.scoreA;
      const scoreB = side === "B" ? value : current.scoreB;
      const winner = winnerFromScore(scoreA, scoreB);
      const scoreChanged = scoreA !== current.scoreA || scoreB !== current.scoreB;
      return {
        ...prev,
        [key]: {
          ...current,
          winner,
          scoreA,
          scoreB,
          completedAt: winner ? (scoreChanged ? new Date().toISOString() : (current.completedAt ?? null)) : null,
        },
      };
    });
  }

  function setOverride(round: number, index: number, side: Side, name: string) {
    const key = slotKey(round, index, side);
    setOverrides((prev) => {
      const next = { ...prev };
      if (name.trim()) next[key] = name.trim();
      else delete next[key];
      return next;
    });
  }

  const isLive = selected !== null && selected.id === liveId;

  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
      <h2 className="mb-1 text-2xl font-semibold">{management ? "Gestione torneo" : "Tabellone completo"}</h2>
      <p className="mb-4 text-sm text-(--text-secondary)">
        {management
          ? "Aggiorna squadre e risultati e salvali: il pubblico vede il salvataggio in onda."
          : "Tutti i turni del torneo a eliminazione diretta."}
      </p>

      {loadError && <p className="mb-4 text-sm text-(--state-error)">{loadError}</p>}

      {!canEdit && (
        <p className="mb-4 rounded-md border border-dashed border-(--surface-border) p-3 text-xs text-(--text-secondary)">
          Tabellone in sola lettura.
          {lastSyncedAt &&
            ` Aggiornato alle ${lastSyncedAt.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}.`}
        </p>
      )}

      {canEdit && (
        <>
          <TournamentBroadcast />
          <StaffPanel
            className="mb-5"
            eyebrow="Configurazione torneo"
            title="Squadre e tabellone"
            description="Scegli la dimensione e aggiorna i nomi delle squadre."
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-(--text-secondary)">Squadre:</span>
              {BRACKET_SIZES.map((s) => (
                <button
                  key={s}
                  onClick={() => requestSizeChange(s)}
                  className={`rounded-(--radius-pill) border px-3 py-1 text-sm transition-colors ${
                    size === s
                      ? "border-(--accent-primary) bg-(--accent-primary) text-(--text-on-accent)"
                      : "border-(--surface-border) text-(--text-secondary) hover:text-(--text-primary)"
                  }`}
                >
                  {s}
                </button>
              ))}
              <Button
                variant="staff-secondary"
                className="ml-auto px-4 py-2 text-xs"
                onClick={() => setEditingTeams((v) => !v)}
              >
                {editingTeams ? "Chiudi nomi" : "Modifica nomi"}
              </Button>
            </div>

            {editingTeams && (
              <div className="mt-4 grid grid-cols-2 gap-2 border-t border-(--surface-border) pt-4 sm:grid-cols-4">
                {teams.map((t, i) => {
                  const tooLong = teamNameTooLong(t);
                  return (
                    <div key={i}>
                      <input
                        aria-label={`Nome squadra ${i + 1}`}
                        aria-invalid={tooLong}
                        aria-describedby={tooLong ? `team-name-error-${i}` : undefined}
                        placeholder={`Max ${TEAM_NAME_MAX_LENGTH} caratteri`}
                        value={t}
                        onChange={(e) => {
                          const next = [...teams];
                          next[i] = e.target.value;
                          setTeams(next);
                        }}
                        className={`field w-full py-2 ${tooLong ? "border-(--state-error)" : ""}`}
                      />
                      {tooLong && (
                        <p id={`team-name-error-${i}`} role="alert" className="mt-1 text-xs text-(--state-error)">
                          Nome della squadra troppo lungo: massimo {TEAM_NAME_MAX_LENGTH} caratteri (ora {t.length}).
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-4 border-t border-(--surface-border) pt-4">
              <label
                htmlFor="tournament-save"
                className="text-xs font-semibold uppercase tracking-[0.12em] text-(--text-secondary)"
              >
                Salvataggi
              </label>
              {saves.length > 0 ? (
                <select
                  id="tournament-save"
                  value={selectedId ?? ""}
                  onChange={(e) => requestOpenSave(e.target.value)}
                  disabled={saving}
                  className="field mt-2 w-full py-2"
                >
                  {saves.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.id === liveId ? " · in onda" : ""} — {formatDate(item.updatedAt)}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="mt-1 text-sm text-(--text-secondary)">
                  Nessun salvataggio: usa “Salva come nuovo” per crearne uno.
                </p>
              )}
              {selected && (
                <p className="mt-2 text-xs text-(--text-secondary)" aria-live="polite">
                  {isLive
                    ? "In onda: quando salvi, il pubblico vede subito le modifiche."
                    : "Privato: il pubblico non lo vede finché non lo metti in onda."}
                  {isDirty && <strong className="text-(--state-warning)"> Ci sono modifiche non salvate.</strong>}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {isDirty && (
                  <Button
                    variant="staff-primary"
                    className="px-4 py-2 text-xs"
                    disabled={saving || hasTooLongNames}
                    onClick={() => void save({})}
                  >
                    {saving ? "Salvo…" : "Salva modifiche"}
                  </Button>
                )}
                {selected && !isLive && (
                  <Button
                    variant="staff-secondary"
                    className="px-4 py-2 text-xs"
                    disabled={saving || hasTooLongNames}
                    onClick={() => void save({ publish: true })}
                  >
                    {isDirty ? "Salva e metti in onda" : "Metti in onda"}
                  </Button>
                )}
                <Button
                  variant="staff-secondary"
                  className="px-4 py-2 text-xs"
                  disabled={saving || hasTooLongNames}
                  onClick={() =>
                    setNewSaveName((selected ? `${selected.name} (copia)` : "Torneo").slice(0, SAVE_NAME_MAX_LENGTH))
                  }
                >
                  Salva come nuovo
                </Button>
              </div>
              {hasTooLongNames && (
                <p role="alert" className="mt-3 text-xs text-(--state-error)">
                  Un nome squadra supera i {TEAM_NAME_MAX_LENGTH} caratteri: accorcialo per poter salvare.
                </p>
              )}
              {saveError && (
                <div role="alert" className="mt-3 text-xs text-(--state-error)">
                  <p>{saveError}</p>
                  {saveConflict && (
                    <Button
                      variant="staff-secondary"
                      className="mt-2 px-4 py-2 text-xs"
                      onClick={() => void reloadSaves(selectedId)}
                    >
                      Ricarica il salvataggio
                    </Button>
                  )}
                </div>
              )}
            </div>
          </StaffPanel>
        </>
      )}

      <div className="max-h-[75vh] overflow-auto pb-4 scrollbar-none [&::-webkit-scrollbar]:hidden">
        <div className="flex min-w-max gap-6 pr-4">
          {Array.from({ length: rounds }, (_, round) => (
            <div
              key={round}
              className={`relative w-56 shrink-0 ${
                round < rounds - 1
                  ? "after:absolute after:-right-3 after:top-0 after:h-full after:border-r after:border-(--surface-border)"
                  : ""
              }`}
            >
              <h3 className="mb-1 text-center font-display text-sm text-(--accent-primary)">
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
                    <div key={index} className="absolute inset-x-0" style={{ top, height: matchHeight }}>
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

      <Modal
        open={pendingSize !== null}
        title="Cambiare numero di squadre?"
        dismissible
        onClose={() => setPendingSize(null)}
        actions={
          <>
            <Button variant="staff-secondary" onClick={() => setPendingSize(null)}>
              Annulla
            </Button>
            <Button variant="staff-primary" onClick={() => pendingSize && applySizeChange(pendingSize)}>
              Cambia
            </Button>
          </>
        }
      >
        <p>
          Passando da <strong>{size}</strong> a <strong>{pendingSize ?? size}</strong> squadre, nomi e risultati attuali
          spariscono dall’editor.
        </p>
        <p className="mt-2">
          Il salvataggio resta com’era finché non premi <strong>Salva modifiche</strong>: per tenerli entrambi usa
          <strong> Salva come nuovo</strong>.
        </p>
      </Modal>

      <Modal
        open={pendingSelectId !== null}
        title="Scartare le modifiche?"
        dismissible
        onClose={() => setPendingSelectId(null)}
        actions={
          <>
            <Button variant="staff-secondary" onClick={() => setPendingSelectId(null)}>
              Annulla
            </Button>
            <Button variant="staff-danger" onClick={() => pendingSelectId && openSave(pendingSelectId)}>
              Scarta e apri
            </Button>
          </>
        }
      >
        <p>
          Le modifiche a <strong>{selected?.name}</strong> non sono state salvate. Aprendo un altro salvataggio andranno
          perse.
        </p>
      </Modal>

      <Modal
        open={newSaveName !== null}
        title="Nuovo salvataggio"
        dismissible={!saving}
        onClose={() => setNewSaveName(null)}
        actions={
          <>
            <Button variant="staff-secondary" onClick={() => setNewSaveName(null)} disabled={saving}>
              Annulla
            </Button>
            <Button
              variant="staff-primary"
              onClick={() => void confirmNewSave()}
              disabled={saving || !newSaveName?.trim()}
            >
              {saving ? "Salvo…" : "Salva"}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void confirmNewSave();
          }}
        >
          <label htmlFor="tournament-save-name" className="block">
            Nome del salvataggio
          </label>
          <input
            id="tournament-save-name"
            autoFocus
            maxLength={SAVE_NAME_MAX_LENGTH}
            value={newSaveName ?? ""}
            onChange={(e) => setNewSaveName(e.target.value)}
            className="field mt-2 w-full py-2"
          />
          <p className="mt-2 text-xs">Resta privato: potrai metterlo in onda quando vuoi.</p>
          {saveError && <p className="mt-2 text-xs text-(--state-error)">{saveError}</p>}
        </form>
      </Modal>
    </section>
  );
}
