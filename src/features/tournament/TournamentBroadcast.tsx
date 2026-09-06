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
  completed: boolean;
  uncertain?: number;
};

export function TournamentBroadcast() {
  const [pendingJob, setPendingJob] = useState<{id:string;message:string;title:string}|null>(null);
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
    void supabase.rpc("get_my_pending_push_broadcast").then(({data})=>{
      if(data?.kind === "tournament") {setPendingJob({id:data.id,message:data.message,title:data.title});setMessage(data.message);setFeedback("C’è un invio da completare. Puoi riprenderlo senza reinviare i lotti conclusi.");}
    });
  }, [loadCount]);

  async function sendBroadcast() {
    const normalized = message.trim();
    if (normalized.length < 2) {
      setError("Scrivi il testo dell’avviso.");
      return;
    }
    if (sending) return;
    if (!pendingJob && !window.confirm(`Inviare questo avviso a ${subscriberCount ?? "tutti i"} dispositivi iscritti?`)) return;

    setSending(true);
    setError(null);
    setFeedback(null);
    const job=pendingJob ?? {id:crypto.randomUUID(),message:normalized,title:"Torneo LAG"};
    setPendingJob(job);
    try {
      let complete=false;
      while(!complete) {
        const {data,error:sendError}=await supabase.functions.invoke<BroadcastResult>("send-push-broadcast",{
          body:{kind:"tournament",title:job.title,message:job.message,broadcast_id:job.id},
        });
        if(sendError || !data) throw new Error("send_interrupted");
        complete=data.completed;
        setFeedback(`Elaborati ${data.sent+data.failed} di ${data.subscribers} dispositivi.`);
        if(complete) {
          setPendingJob(null);
          setFeedback(`Avviso inviato a ${data.sent} dispositivi; ${data.failed} invii non riusciti${data.uncertain ? `, di cui ${data.uncertain} con esito incerto e non ripetuti` : ""}.`);
          void loadCount();
        }
      }
    } catch {setError("Invio interrotto. Premi Riprendi invio tra poco: i lotti conclusi non verranno ripetuti.");}
    finally {setSending(false);}

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
        disabled={sending || pendingJob !== null}
        value={message}
        maxLength={240}
        rows={3}
        onChange={(event) => setMessage(event.target.value)}
        className="field mt-3 w-full resize-none"
        aria-label="Testo della notifica torneo"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-[var(--text-secondary)]">{message.length}/240</span>
        <Button variant="staff-primary" onClick={() => void sendBroadcast()} disabled={sending || (!pendingJob && subscriberCount === 0)}>
          {sending ? "Invio…" : pendingJob ? "Riprendi invio" : "Invia avviso a tutti"}
        </Button>
      </div>
      {feedback && <p className="mt-3 text-xs text-[var(--state-success)]">{feedback}</p>}
      {error && <p className="mt-3 text-xs text-[var(--state-error)]">{error}</p>}
    </StaffPanel>
  );
}
