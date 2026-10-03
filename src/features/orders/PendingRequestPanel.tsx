import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TurnstileChallenge } from "../../components/ui/TurnstileChallenge";
import type { PendingOrderRequest } from "./pendingOrder";

type Props = {
  request: PendingOrderRequest;
  /** Una richiesta di un evento precedente non si può più recuperare: resta solo da eliminarla. */
  fromOldEvent: boolean;
  error: string | null;
  submitting: boolean;
  challengeAttempt: number;
  challengeToken: string;
  onChallengeToken: (token: string) => void;
  onRecover: () => void;
  onAbandon: () => void;
};

/**
 * Una richiesta interrotta (per esempio rete caduta) resta in evidenza in cima alla pagina,
 * mentre ordini già fatti, QR e carrello restano utilizzabili.
 */
export function PendingRequestPanel({
  request,
  fromOldEvent,
  error,
  submitting,
  challengeAttempt,
  challengeToken,
  onChallengeToken,
  onRecover,
  onAbandon,
}: Props) {
  const [confirmAbandon, setConfirmAbandon] = useState(false);

  return (
    <section
      role="region"
      aria-labelledby="pending-request-title"
      className="mt-4 rounded-[var(--radius-md)] border-2 border-[var(--state-warning)] p-4 text-left"
    >
      <h2 id="pending-request-title" className="text-lg">
        Un ordine non è stato confermato
      </h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        {fromOldEvent
          ? "Questa richiesta è di un evento precedente e non può più essere inviata. Non hai pagato nulla: puoi eliminarla."
          : "La connessione si è interrotta durante l’invio. Verifichiamo se è arrivato in cassa, senza crearne un doppione."}
      </p>
      <ul className="my-3 space-y-1 text-sm">
        {request.items.map((line) => (
          <li key={line.id}>
            {line.qty} × {line.name}
          </li>
        ))}
      </ul>
      {error && !fromOldEvent && (
        <p role="alert" className="mb-3 text-sm text-[var(--state-warning)]">
          {error}
        </p>
      )}
      {fromOldEvent ? (
        <Button variant="ghost" className="w-full" onClick={onAbandon}>
          Elimina questa richiesta
        </Button>
      ) : (
        <>
          <TurnstileChallenge key={challengeAttempt} onToken={onChallengeToken} />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button className="w-full" disabled={submitting || !challengeToken} onClick={onRecover}>
              {submitting ? "Verifico l’ordine…" : "Recupera ordine"}
            </Button>
            <Button variant="ghost" className="w-full" disabled={submitting} onClick={() => setConfirmAbandon(true)}>
              Rinuncia a questa richiesta
            </Button>
          </div>
        </>
      )}
      <Modal
        open={confirmAbandon}
        title="Rinunciare alla richiesta?"
        dismissible
        onClose={() => setConfirmAbandon(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmAbandon(false)}>
              No, riprovo
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmAbandon(false);
                onAbandon();
              }}
            >
              Sì, rinuncio
            </Button>
          </>
        }
      >
        <p>
          Se l’ordine era comunque arrivato in cassa, resterà in attesa di pagamento per 60 minuti e poi scadrà da solo:
          non paghi nulla finché non passi in cassa.
        </p>
      </Modal>
    </section>
  );
}
