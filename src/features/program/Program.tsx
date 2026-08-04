import { useEffect, useState } from "react";
import { Card } from "../../components/ui/Card";
import { RoleLogin } from "../auth/RoleLogin";
import { useAuth } from "../auth/AuthContext";
import { supabase, isSupabaseConfigured } from "../../lib/supabaseClient";
import { ProgramGrid, type ProgramSlotData } from "./ProgramGrid";

const STAGES = ["Stage 1", "Stage 2"];

const FALLBACK_SLOTS: ProgramSlotData[] = [
  { id: "f1", stage: "Stage 1", title: "Apertura porte — esempio", start_time: "18:00", end_time: "19:00" },
  { id: "f2", stage: "Stage 1", title: "DJ set — esempio", start_time: "19:00", end_time: "21:00" },
  { id: "f3", stage: "Stage 2", title: "Live band — esempio", start_time: "19:30", end_time: "20:30" },
];

/*
  Programma — stessa logica degli annunci: dati reali da Supabase con
  realtime (fetch completo ad ogni cambiamento, sono poche righe, non
  serve ottimizzare un merge incrementale), fallback di esempio se
  Supabase non è ancora configurato. Editing riservato allo STESSO
  ruolo 'staff' degli annunci — nessuna autenticazione a parte, come
  richiesto: chi pubblica annunci pubblica anche il programma.

  "Scaletta modificabile": ogni riga nella lista sotto è editabile
  direttamente (nome, orario inizio/fine, palco) — cambia un campo,
  si salva subito. La griglia calendario si ricalcola da sola dai
  dati, non è un disegno separato da tenere sincronizzato a mano.
*/
export function Program() {
  const { role } = useAuth();
  const canEdit = role === "staff";
  const [slots, setSlots] = useState<ProgramSlotData[]>(FALLBACK_SLOTS);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  const fetchSlots = async () => {
    const { data, error } = await supabase
      .from("program_slots")
      .select("id, stage, title, start_time, end_time")
      .order("start_time", { ascending: true });
    if (!error && data) setSlots(data);
    setLoading(false);
  };

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    fetchSlots();
    const channel = supabase
      .channel("program-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "program_slots" }, fetchSlots)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function addSlot() {
    await supabase
      .from("program_slots")
      .insert({ stage: STAGES[0], title: "Nuovo evento", start_time: "20:00", end_time: "21:00" });
    fetchSlots();
  }

  async function updateSlot(id: string, patch: Partial<ProgramSlotData>) {
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    await supabase.from("program_slots").update(patch).eq("id", id);
  }

  async function deleteSlot(id: string) {
    setSlots((prev) => prev.filter((s) => s.id !== id));
    await supabase.from("program_slots").delete().eq("id", id);
  }

  return (
    <section id="programma" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Programma</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Due palchi in contemporanea — orari indicativi, possono aggiornarsi.
      </p>

      <RoleLogin requiredRole="staff" label="Staff" />

      {canEdit && (
        <Card className="mb-6 flex flex-col gap-2">
          {slots.map((slot) => (
            <div
              key={slot.id}
              className="flex flex-wrap items-center gap-2 border-b border-[var(--surface-border)] pb-2 last:border-0 last:pb-0"
            >
              <select
                value={slot.stage}
                onChange={(e) => updateSlot(slot.id, { stage: e.target.value })}
                className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)]"
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
                className="min-w-[140px] flex-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-transparent px-2 py-1 text-sm text-[var(--text-primary)]"
              />
              <input
                type="time"
                value={slot.start_time}
                onChange={(e) => updateSlot(slot.id, { start_time: e.target.value })}
                className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)]"
              />
              <span className="text-xs text-[var(--text-secondary)]">–</span>
              <input
                type="time"
                value={slot.end_time}
                onChange={(e) => updateSlot(slot.id, { end_time: e.target.value })}
                className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)]"
              />
              <button
                onClick={() => deleteSlot(slot.id)}
                className="text-xs text-[var(--state-error)] hover:underline"
              >
                Elimina
              </button>
            </div>
          ))}
          <button
            onClick={addSlot}
            className="mt-1 self-start text-xs text-[var(--accent-primary)] hover:underline"
          >
            + Aggiungi evento
          </button>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-[var(--text-secondary)]">Carico il programma...</p>
      ) : (
        <ProgramGrid slots={slots} stages={STAGES} />
      )}
    </section>
  );
}
