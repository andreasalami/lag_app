import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { StaffPanel } from "../../components/ui/StaffPanel";
import { supabase } from "../../lib/supabaseClient";

const DEFAULT_MESSAGE = "Il prossimo turno del torneo sta per iniziare. Presentati nell’area torneo.";

type BroadcastResult = {
  subscribers: number;
  sent: number;
  failed: number;
  removed: number;
};

export function TournamentBroadcast() {
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCount = useCallback(async () => {
    const { data, error: countError } = await supabase.rpc("get_push_subscription_count");
    if (!countError && typeof data === "number") setSubscriberCount(data);
  }, []);

  useEffect(() => {
    void loadCount();
  }, [loadCount]);

  async function sendBroadcast() {
    const normalized = message.trim();
    if (normalized.length < 2) {
      setError("Scrivi il testo dell’avviso.");
      return;
    }
    if (!window.confirm(`Inviare questo avviso a ${subscriberCount ?? "tutti i"} dispositivi iscritti?`)) return;

    setSending(true);
    setError(null);
    setFeedback(null);
    const { data, error: sendError } = await supabase.functions.invoke<BroadcastResult>("send-push-broadcast", {
      body: { kind: "tournament", title: "Torneo LAG", message: normalized },
    });
    setSending(false);
    if (sendError || !data) {
      setError("Avviso non inviato. Controlla la configurazione Push e riprova.");
      return;
    }

    setSubscriberCount(Math.max(0, data.subscribers - data.removed));
    setFeedback(data.failed > 0
      ? `Avviso consegnato a ${data.sent} dispositivi; ${data.failed} invii non riusciti.`
      : `Avviso inviato a ${data.sent} dispositivi.`);
  }

  return (
    <StaffPanel
      className="mb-5"
      eyebrow="Notifiche torneo"
      title="Avviso a tutti"
      description={subscriberCount === null ? "Controllo i dispositivi iscritti…" : `${subscriberCount} dispositivi iscritti alle notifiche.`}
      action={<Button variant="staff-secondary" className="px-4 py-2 text-xs" onClick={() => void loadCount()}>Aggiorna conteggio</Button>}
    >
      <p className="mb-3 text-xs text-[var(--text-secondary)]">Per una prova completa su iPhone, chiudi la Web App sul telefono e invia qui un messaggio di test.</p>
      <textarea
        value={message}
        maxLength={240}
        rows={3}
        onChange={(event) => setMessage(event.target.value)}
        className="field mt-3 w-full resize-none"
        aria-label="Testo della notifica torneo"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-[var(--text-secondary)]">{message.length}/240</span>
        <Button variant="staff-primary" onClick={() => void sendBroadcast()} disabled={sending || subscriberCount === 0}>
          {sending ? "Invio…" : "Invia avviso a tutti"}
        </Button>
      </div>
      {feedback && <p className="mt-3 text-xs text-[var(--state-success)]">{feedback}</p>}
      {error && <p className="mt-3 text-xs text-[var(--state-error)]">{error}</p>}
    </StaffPanel>
  );
}
