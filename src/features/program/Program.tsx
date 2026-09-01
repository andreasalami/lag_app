import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { StaffPanel } from "../../components/ui/StaffPanel";
import { SaveBanner } from "../../components/ui/SaveBanner";
import { useAuth } from "../auth/AuthContext";
import { supabase } from "../../lib/supabaseClient";
import { useSupabaseRows } from "../../lib/useSupabaseRows";
import { ProgramGrid, type ProgramSlotData } from "./ProgramGrid";

const STAGES = ["Stage 1", "Stage 2"];
const MAX_DAYS = 3;

const FALLBACK_SLOTS: ProgramSlotData[] = [
  { id: "f1", day: 1, stage: "Stage 1", title: "Apertura porte — esempio", start_time: "18:00", end_time: "19:00" },
  { id: "f2", day: 1, stage: "Stage 1", title: "DJ set — esempio", start_time: "19:00", end_time: "21:00" },
  { id: "f3", day: 1, stage: "Stage 2", title: "Live band — esempio", start_time: "19:30", end_time: "20:30" },
];

const NEW_ID_PREFIX = "new:";
const isNewId = (id: string) => id.startsWith(NEW_ID_PREFIX);

/*
  Programma — dati Supabase, editing riservato al ruolo 'staff'/'admin'.

  Stesso pattern di Menu.tsx: tutto locale finché non premi "Salva",
  poi un'unica RPC (bulk_upsert_program_slots) applica tutto in una
  transazione atomica.

  Bug risolto qui: Giorno e Stage scrivevano DIRETTAMENTE sul DB
  all'onChange, ma senza aggiornare `slots` in locale — la select
  restava agganciata al vecchio valore e "tornava indietro" a schermo
  anche se il salvataggio sul DB era andato a buon fine. Sembrava che
  la modifica non avesse effetto (da qui l'istinto di cancellare e
  ricreare la riga). Ora ogni campo, Giorno e Stage compresi, aggiorna
  solo lo stato locale: la scrittura vera è deferita al tasto Salva,
  come tutto il resto.
*/
export function Program({ management = false }: { management?: boolean }) {
  const { role } = useAuth();
  const canManage = role === "staff" || role === "admin";
  const canEdit = management && canManage;
  const [days, setDays] = useState(1);
  const [savedDays, setSavedDays] = useState(1);
  const { rows: slots, setRows: setSlots, loading, error: loadError, refetch } = useSupabaseRows<ProgramSlotData>({
    table: "program_slots",
    select: "id, day, stage, title, start_time, end_time",
    orderBy: [{ column: "day" }, { column: "start_time" }],
    fallback: FALLBACK_SLOTS,
  });

  const [savedSlots, setSavedSlots] = useState<ProgramSlotData[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedOnceRef = useRef(false);

  useEffect(() => {
    if (!loading && !savedOnceRef.current) {
      setSavedSlots(slots);
      savedOnceRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Il numero di giorni è condiviso (riga singola su Supabase,
  // program_settings) — non più uno state locale al browser di chi
  // edita, che prima resettava a 1 ad ogni reload/dispositivo diverso
  // nascondendo i giorni successivi al primo anche con eventi già
  // salvati lì sopra. Il programma si compila giorni prima
  // dell'evento: niente realtime, basta leggerlo una volta al
  // caricamento, come tournament_state.
  useEffect(() => {
    let cancelled = false;
    async function loadSettings() {
      const { data, error } = await supabase.from("program_settings").select("days").eq("id", "main").maybeSingle();
      if (cancelled) return;
      if (error) console.error("[Program] Errore caricamento giorni:", error.message);
      const persistedDays = data?.days ?? 1;
      setDays(persistedDays);
      setSavedDays(persistedDays);
    }
    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  const isDirty = days !== savedDays || deletedIds.length > 0 || JSON.stringify(slots) !== JSON.stringify(savedSlots);

  // Rete di sicurezza: se per qualsiasi motivo il valore salvato non
  // è ancora arrivato (o è rimasto indietro) ma esistono comunque
  // eventi su un giorno più alto, quel giorno va mostrato comunque —
  // non deve mai sparire un evento già salvato.
  const displayDays = slots.reduce((max, slot) => Math.max(max, slot.day), days);

  function addSlot() {
    setSlots((prev) => [
      ...prev,
      { id: `${NEW_ID_PREFIX}${crypto.randomUUID()}`, day: 1, stage: STAGES[0], title: "Nuovo evento", start_time: "20:00", end_time: "21:00" },
    ]);
  }

  function deleteSlot(id: string) {
    setSlots((prev) => prev.filter((s) => s.id !== id));
    if (!isNewId(id)) setDeletedIds((prev) => [...prev, id]);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);

    const invalidSlot = slots.some((slot) =>
      !slot.title.trim()
      || slot.title.length > 200
      || slot.day < 1
      || slot.day > days
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.start_time)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.end_time)
    );
    if (invalidSlot) {
      setSaveError("Controlla titoli, giorni e orari. Ogni evento deve rientrare nei giorni pubblicati.");
      setSaving(false);
      return;
    }

    const created = slots
      .filter((s) => isNewId(s.id))
      .map(({ day, stage, title, start_time, end_time }) => ({ day, stage, title, start_time, end_time }));

    const updated = slots.filter((s) => {
      if (isNewId(s.id)) return false;
      const original = savedSlots.find((o) => o.id === s.id);
      return original && JSON.stringify(original) !== JSON.stringify(s);
    });

    const { error } = await supabase.rpc("save_program", {
      p_days: days,
      p_created: created,
      p_updated: updated,
      p_deleted: deletedIds,
    });

    if (error) {
      console.error("[Program] Errore salvataggio:", error.message);
      setSaveError("Salvataggio non riuscito. Riprova.");
      setSaving(false);
      return;
    }

    const fresh = await refetch();
    if (fresh) setSavedSlots(fresh);
    setSavedDays(days);
    setDeletedIds([]);
    setSaving(false);
  }

  return (
    <section id="programma" className="mx-auto w-full max-w-3xl py-10 sm:px-4">
      <div className="px-4 sm:px-0">
        <h2 className="mb-1 text-2xl font-semibold">{management ? "Scaletta" : "Programma"}</h2>
        <p className="mb-4 text-sm text-[var(--text-secondary)]">
          {management
            ? "Modifica giorni, palchi e orari pubblicati nella Home."
            : "Due palchi in contemporanea — l’orario può continuare dopo mezzanotte."}
        </p>
        {!management && canManage && (
          <Button href={`${import.meta.env.BASE_URL}#gestione-programma`} className="mb-5 w-full justify-start sm:w-64">
            Gestisci Scaletta
          </Button>
        )}
      </div>

      {canEdit && (
        <StaffPanel className="mx-4 mb-6 sm:mx-0" eyebrow="Programmazione evento" title="Giorni, palchi e orari" description="Le modifiche restano in bozza finché non premi Salva." contentClassName="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            Giorni dell’evento
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="field text-xs">
              {Array.from({ length: MAX_DAYS }, (_, index) => index + 1).map((dayCount) => (
                <option key={dayCount} value={dayCount}>{dayCount}</option>
              ))}
            </select>
          </label>
          {slots.map((slot) => (
            <div
              key={slot.id}
              className="grid gap-2 border-b border-[var(--surface-border)] pb-3 last:border-0 last:pb-0 sm:flex sm:flex-wrap sm:items-center sm:pb-2"
            >
              <select
                value={slot.day}
                onChange={(e) => setSlots((prev) => prev.map((s) => (s.id === slot.id ? { ...s, day: Number(e.target.value) } : s)))}
                className="field min-w-0 text-xs sm:w-auto"
              >
                {Array.from({ length: displayDays }, (_, index) => index + 1).map((day) => (
                  <option key={day} value={day}>Giorno {day}</option>
                ))}
              </select>
              <select
                value={slot.stage}
                onChange={(e) => setSlots((prev) => prev.map((s) => (s.id === slot.id ? { ...s, stage: e.target.value } : s)))}
                className="field min-w-0 text-xs sm:w-auto"
              >
                {STAGES.map((s) => (
                  <option key={s} value={s} className="bg-[var(--surface-solid)]">
                    {s}
                  </option>
                ))}
              </select>
              <input
                required
                maxLength={200}
                value={slot.title}
                onChange={(e) => setSlots((prev) => prev.map((s) => (s.id === slot.id ? { ...s, title: e.target.value } : s)))}
                className="field col-span-2 min-w-0 w-full sm:col-span-auto sm:min-w-[140px] sm:flex-1"
              />
              <div className="col-span-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:contents">
                <input
                  type="time"
                  value={slot.start_time}
                  onChange={(e) => setSlots((prev) => prev.map((s) => (s.id === slot.id ? { ...s, start_time: e.target.value } : s)))}
                  className="field min-w-0 w-full text-xs"
                />
                <span className="text-center text-xs text-[var(--text-secondary)]">–</span>
                <input
                  type="time"
                  value={slot.end_time}
                  onChange={(e) => setSlots((prev) => prev.map((s) => (s.id === slot.id ? { ...s, end_time: e.target.value } : s)))}
                  className="field min-w-0 w-full text-xs"
                />
              </div>
              <button
                onClick={() => deleteSlot(slot.id)}
                className="justify-self-start text-xs text-[var(--state-error)] hover:underline sm:justify-self-auto"
              >
                Elimina
              </button>
            </div>
          ))}
          <button onClick={addSlot} className="mt-1 self-start text-xs text-[var(--accent-primary)] hover:underline">
            + Aggiungi evento
          </button>
        </StaffPanel>
      )}

      {loadError ? (
        <p className="px-4 text-sm text-[var(--state-error)] sm:px-0">Programma non disponibile. Ricarica la pagina.</p>
      ) : loading ? (
        <p className="px-4 text-sm text-[var(--text-secondary)] sm:px-0">Carico il programma...</p>
      ) : (
        <ProgramGrid slots={slots} stages={STAGES} days={displayDays} />
      )}

      {/* Stesso banner condiviso di Menu e Torneo (vedi SaveBanner.tsx):
          niente più tasto incollato dentro la Card, un solo posto dove
          cercare "Salva" in tutta l'interfaccia. */}
      {canEdit && isDirty && (
        <SaveBanner
          message="Ci sono modifiche al Programma non ancora salvate."
          saving={saving}
          error={saveError}
          onSave={handleSave}
        />
      )}
    </section>
  );
}
