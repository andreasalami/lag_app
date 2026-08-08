import { useState } from "react";
import { Card } from "../../components/ui/Card";
import { RoleLogin } from "../auth/RoleLogin";
import { useAuth } from "../auth/AuthContext";
import { supabase } from "../../lib/supabaseClient";
import { useSupabaseRows } from "../../lib/useSupabaseRows";
import { ProgramGrid, type ProgramSlotData } from "./ProgramGrid";

const STAGES = ["Stage 1", "Stage 2"];

const FALLBACK_SLOTS: ProgramSlotData[] = [
  { id: "f1", day: 1, stage: "Stage 1", title: "Apertura porte — esempio", start_time: "18:00", end_time: "19:00" },
  { id: "f2", day: 1, stage: "Stage 1", title: "DJ set — esempio", start_time: "19:00", end_time: "21:00" },
  { id: "f3", day: 1, stage: "Stage 2", title: "Live band — esempio", start_time: "19:30", end_time: "20:30" },
];

/*
  Programma — dati reali da Supabase (fetch + realtime via
  useSupabaseRows), editing riservato allo STESSO ruolo 'staff' degli
  annunci: nessuna autenticazione a parte.

  "Scaletta modificabile": ogni riga nella lista è editabile
  direttamente — cambia un campo, si salva subito. La griglia
  calendario sotto si ricalcola da sola da questi dati.
*/
export function Program() {
  const { role } = useAuth();
  const canEdit = role === "staff" || role === "admin";
  const [days, setDays] = useState(1);
  const { rows: slots, setRows: setSlots, loading, refetch } = useSupabaseRows<ProgramSlotData>({
    table: "program_slots",
    select: "id, day, stage, title, start_time, end_time",
    orderBy: [{ column: "day" }, { column: "start_time" }],
    fallback: FALLBACK_SLOTS,
  });

  async function addSlot() {
    const { error } = await supabase
      .from("program_slots")
      .insert({ day: 1, stage: STAGES[0], title: "Nuovo evento", start_time: "20:00", end_time: "21:00" });
    if (error) console.error("[Program] Errore inserimento:", error.message);
    refetch();
  }

  async function updateSlot(id: string, patch: Partial<ProgramSlotData>) {
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const { error } = await supabase.from("program_slots").update(patch).eq("id", id);
    // Se la scrittura vera fallisce (es. sessione scaduta), lo stato
    // ottimistico sopra resterebbe sbagliato senza che nessuno se ne
    // accorga: il refetch riallinea alla realtà del DB.
    if (error) {
      console.error("[Program] Errore aggiornamento:", error.message);
      refetch();
    }
  }

  async function deleteSlot(id: string) {
    setSlots((prev) => prev.filter((s) => s.id !== id));
    const { error } = await supabase.from("program_slots").delete().eq("id", id);
    if (error) {
      console.error("[Program] Errore eliminazione:", error.message);
      refetch();
    }
  }

  return (
    <section id="programma" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Programma</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Due palchi in contemporanea — l’orario può continuare dopo mezzanotte.
      </p>

      <RoleLogin requiredRole="staff" label="Staff" />

      {canEdit && (
        <Card className="mb-6 flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            Giorni dell’evento
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="field text-xs">
              {[1, 2].map((dayCount) => <option key={dayCount} value={dayCount}>{dayCount}</option>)}
            </select>
          </label>
          {slots.map((slot) => (
            <div
              key={slot.id}
              className="flex flex-wrap items-center gap-2 border-b border-[var(--surface-border)] pb-2 last:border-0 last:pb-0"
            >
              <select
                value={slot.day}
                onChange={(e) => updateSlot(slot.id, { day: Number(e.target.value) })}
                className="field text-xs"
              >
                {Array.from({ length: days }, (_, index) => index + 1).map((day) => (
                  <option key={day} value={day}>Giorno {day}</option>
                ))}
              </select>
              <select
                value={slot.stage}
                onChange={(e) => updateSlot(slot.id, { stage: e.target.value })}
                className="field text-xs"
              >
                {STAGES.map((s) => (
                  <option key={s} value={s} className="bg-[var(--surface-solid)]">
                    {s}
                  </option>
                ))}
              </select>
              <input
                value={slot.title}
                onChange={(e) => updateSlot(slot.id, { title: e.target.value })}
                className="field min-w-[140px] flex-1"
              />
              <input
                type="time"
                value={slot.start_time}
                onChange={(e) => updateSlot(slot.id, { start_time: e.target.value })}
                className="field text-xs"
              />
              <span className="text-xs text-[var(--text-secondary)]">–</span>
              <input
                type="time"
                value={slot.end_time}
                onChange={(e) => updateSlot(slot.id, { end_time: e.target.value })}
                className="field text-xs"
              />
              <button
                onClick={() => deleteSlot(slot.id)}
                className="text-xs text-[var(--state-error)] hover:underline"
              >
                Elimina
              </button>
            </div>
          ))}
          <button onClick={addSlot} className="mt-1 self-start text-xs text-[var(--accent-primary)] hover:underline">
            + Aggiungi evento
          </button>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-[var(--text-secondary)]">Carico il programma...</p>
      ) : (
        <ProgramGrid slots={slots} stages={STAGES} days={days} />
      )}
    </section>
  );
}
