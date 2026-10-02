import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Notice } from "../../components/ui/Notice";
import { StaffPageHeading, StaffPanel } from "../../components/ui/StaffPanel";
import { supabase } from "../../lib/supabaseClient";
import { downloadCsv, type EventReport } from "../orders/orderUtils";
import { parseIncomeSnapshot } from "./incomeSnapshot";
import { downloadIncomeSnapshotPdf } from "./incomeSnapshotPdf";

type EventState = {
  id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  manual_closed: boolean;
  permanently_closed_at: string | null;
  max_pending_orders: number;
  pending_count: number;
};

type EventSettings = { p_name: string; p_opens_at: string; p_closes_at: string; p_max_pending_orders: number };

const CLOSE_CONFIRMATION = "CHIUDI EVENTO";

function toLocalDateTime(iso: string) {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Apertura, chiusura e situazione incassi dell'evento: riservata a cassa e admin (vedi App.tsx). */
export function EventManagement() {
  const [eventState, setEventState] = useState<EventState | null>(null);
  const [eventName, setEventName] = useState("");
  const [eventOpens, setEventOpens] = useState("");
  const [eventCloses, setEventCloses] = useState("");
  const [eventLimit, setEventLimit] = useState("100");
  const [busy, setBusy] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [closeEventModal, setCloseEventModal] = useState(false);
  const [closeEventText, setCloseEventText] = useState("");

  const loadEventState = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_order_event_admin_state");
    if (error || !data) {
      setMessage("Impostazioni evento non disponibili. Ricarica la pagina.");
      return;
    }
    const next = data as EventState;
    setEventState(next);
    setEventName(next.name);
    setEventOpens(toLocalDateTime(next.opens_at));
    setEventCloses(toLocalDateTime(next.closes_at));
    setEventLimit(String(next.max_pending_orders));
  }, []);

  useEffect(() => {
    void loadEventState();
  }, [loadEventState]);

  // Un campo data svuotato rende `new Date("")` non valido: si avvisa prima di chiamare il server.
  function settingsFromForm(): EventSettings | null {
    const opens = new Date(eventOpens);
    const closes = new Date(eventCloses);
    const limit = Number(eventLimit);
    if (!eventName.trim()) return fail("Inserisci il nome dell’evento.");
    if (Number.isNaN(opens.getTime()) || Number.isNaN(closes.getTime())) return fail("Inserisci data e ora sia per l’apertura sia per la chiusura degli ordini.");
    if (closes <= opens) return fail("La chiusura degli ordini deve essere dopo l’apertura.");
    if (!Number.isInteger(limit) || limit < 10 || limit > 1000) return fail("Il massimo di ordini in attesa deve essere un numero intero tra 10 e 1000.");
    return { p_name: eventName.trim(), p_opens_at: opens.toISOString(), p_closes_at: closes.toISOString(), p_max_pending_orders: limit };
  }

  function fail(text: string) {
    setMessage(text);
    return null;
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  function saveEventSettings() {
    const settings = settingsFromForm();
    if (!settings) return;
    void run(async () => {
      const { error } = await supabase.rpc("update_order_event", settings);
      if (error) { setMessage("Impostazioni evento non salvate. Controlla date e limite."); return; }
      setMessage("Impostazioni evento salvate.");
      await loadEventState();
    });
  }

  function createNextEvent() {
    const settings = settingsFromForm();
    if (!settings) return;
    void run(async () => {
      const { error } = await supabase.rpc("create_next_order_event", settings);
      if (error) { setMessage("Nuovo evento non creato. Controlla nome e date future."); return; }
      setMessage("Nuovo evento creato: la numerazione ripartirà da 1.");
      await loadEventState();
    });
  }

  function toggleOrderingPaused() {
    if (!eventState) return;
    void run(async () => {
      const { error } = await supabase.rpc("set_ordering_paused", { p_paused: !eventState.manual_closed });
      if (error) { setMessage("Stato ordinazioni non aggiornato. Riprova."); return; }
      await loadEventState();
    });
  }

  function closeEventPermanently() {
    void run(async () => {
      const { data, error } = await supabase.rpc("close_order_event");
      setCloseEventModal(false);
      setCloseEventText("");
      if (error || !data) { setMessage("Evento non chiuso. Riprova."); return; }
      downloadCsv(data as EventReport);
      setMessage("Evento chiuso e report anonimo scaricato.");
      await loadEventState();
    });
  }

  async function downloadExistingReport() {
    const { data, error } = await supabase.rpc("get_order_event_report");
    if (error || !data) setMessage("Report non disponibile. Riprova.");
    else downloadCsv(data as EventReport);
  }

  async function downloadSnapshot() {
    setSnapshotBusy(true);
    try {
      const { data, error } = await supabase.rpc("get_order_event_snapshot");
      const snapshot = error ? null : parseIncomeSnapshot(data);
      if (!snapshot) { setMessage("Situazione incassi non disponibile. Controlla la connessione e riprova."); return; }
      await downloadIncomeSnapshotPdf(snapshot);
    } catch {
      setMessage("PDF non creato. Riprova tra qualche secondo.");
    } finally {
      setSnapshotBusy(false);
    }
  }

  const closed = Boolean(eventState?.permanently_closed_at);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-28 pt-8">
      <StaffPageHeading title="Gestione evento" description="Apertura e chiusura delle ordinazioni, situazione incassi e report finale." />
      {/* Fisso in basso: su telefono i pulsanti sono in fondo alla pagina e un avviso in cima resterebbe fuori schermo. */}
      {message && (
        <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl">
          <Notice className="surface-solid shadow-lg" onDismiss={() => setMessage(null)}>{message}</Notice>
        </div>
      )}

      <StaffPanel
        className="mb-6"
        eyebrow="Situazione incassi"
        title="Come sta andando"
        description="Un PDF semplice con incasso, andamento ora per ora e prodotti più e meno venduti. Puoi scaricarlo in qualsiasi momento: non contiene nomi o note dei clienti."
      >
        <Button variant="staff-primary" onClick={() => void downloadSnapshot()} disabled={snapshotBusy}>
          {snapshotBusy ? "Preparo il PDF…" : "Scarica la situazione incassi (PDF)"}
        </Button>
      </StaffPanel>

      {!eventState ? (
        <StaffPanel eyebrow="Configurazione ordini" title="Carico l’evento…" description="Recupero apertura, chiusura e limite degli ordini.">
          <p className="text-sm text-[var(--text-secondary)]">Attendi un momento.</p>
        </StaffPanel>
      ) : (
        <StaffPanel
          eyebrow="Configurazione ordini"
          title={eventState.name}
          description={`${eventState.pending_count} ordini in attesa su ${eventState.max_pending_orders}`}
          action={closed ? (
            <span className="text-sm text-[var(--state-error)]">Evento chiuso definitivamente</span>
          ) : (
            <span className={`text-sm ${eventState.manual_closed ? "text-[var(--state-warning)]" : "text-[var(--state-success)]"}`}>
              {eventState.manual_closed ? "Ordinazioni sospese" : "Gestione automatica attiva"}
            </span>
          )}
        >
          <div className="flex flex-col gap-3">
            <label>
              <span className="mb-1 block text-xs">Nome evento</span>
              <input value={eventName} onChange={(event) => setEventName(event.target.value)} className="field w-full py-2" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                <span className="mb-1 block text-xs">Apertura ordini</span>
                <input type="datetime-local" required value={eventOpens} onChange={(event) => setEventOpens(event.target.value)} className="field w-full py-2" />
              </label>
              <label>
                <span className="mb-1 block text-xs">Chiusura ordini</span>
                <input type="datetime-local" required value={eventCloses} onChange={(event) => setEventCloses(event.target.value)} className="field w-full py-2" />
              </label>
            </div>
            <label>
              <span className="mb-1 block text-xs">Massimo ordini contemporaneamente in attesa</span>
              <input type="number" inputMode="numeric" min={10} max={1000} step={1} value={eventLimit} onChange={(event) => setEventLimit(event.target.value)} className="field w-full py-2 sm:w-40" />
            </label>

            {closed ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="staff-secondary" onClick={() => void downloadExistingReport()}>Scarica di nuovo il CSV</Button>
                <Button variant="staff-primary" onClick={createNextEvent} disabled={busy}>Crea nuovo evento</Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button variant="staff-primary" onClick={saveEventSettings} disabled={busy}>Salva orari e limite</Button>
                  <Button variant={eventState.manual_closed ? "staff-primary" : "staff-secondary"} onClick={toggleOrderingPaused} disabled={busy}>
                    {eventState.manual_closed ? "Riapri ordinazioni" : "Chiudi ordinazioni ora"}
                  </Button>
                </div>
                <div className="mt-3 border-t border-[var(--surface-border)] pt-3">
                  <p className="text-xs text-[var(--state-error)]">La chiusura definitiva annulla gli ordini non pagati, anonimizza i dati e produce il CSV finale.</p>
                  <Button variant="staff-danger" className="mt-2" onClick={() => setCloseEventModal(true)} disabled={busy}>Chiudi definitivamente l’evento</Button>
                </div>
              </>
            )}
          </div>
        </StaffPanel>
      )}

      <Modal
        open={closeEventModal}
        title="Chiusura definitiva evento"
        dismissible={!busy}
        onClose={() => setCloseEventModal(false)}
        actions={(
          <>
            <Button variant="staff-secondary" onClick={() => setCloseEventModal(false)} disabled={busy}>Annulla</Button>
            <Button variant="staff-danger" onClick={closeEventPermanently} disabled={closeEventText !== CLOSE_CONFIRMATION || busy}>
              Chiudi e scarica CSV
            </Button>
          </>
        )}
      >
        <p>L’operazione è irreversibile. Digita <strong className="text-[var(--text-primary)]">{CLOSE_CONFIRMATION}</strong> per confermare.</p>
        <input aria-label={`Digita ${CLOSE_CONFIRMATION}`} value={closeEventText} onChange={(event) => setCloseEventText(event.target.value)} className="field mt-3 w-full py-2" />
      </Modal>
    </main>
  );
}
