import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { commitmentSummary, fetchCommitments, setSuspended, type Commitment } from "./menuAvailability";

type Props = {
  item: { id: string; name: string; suspended: boolean };
  /** Chiamata dopo che il database ha confermato il nuovo stato. */
  onChanged: (suspended: boolean) => void;
  /** Il prodotto non esiste più o non è gestibile: chi usa il pulsante ricarica l'elenco. */
  onMissing?: () => void;
};

/**
 * Sospendi/Riattiva, applicato subito. Prima di sospendere mostra quanti ordini già inviati
 * contengono il prodotto: quelli vanno comunque evasi, la sospensione vale per i successivi.
 */
export function SuspendButton({ item, onChanged, onMissing }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // undefined: finestra chiusa; null: conteggio non disponibile.
  const [confirm, setConfirm] = useState<Commitment | "none" | null | undefined>(undefined);

  async function apply(suspended: boolean) {
    setBusy(true);
    setError(null);
    const outcome = await setSuspended(item.id, suspended);
    setBusy(false);
    setConfirm(undefined);
    if (outcome === "ok") onChanged(suspended);
    else if (outcome === "missing") {
      setError("Prodotto non più disponibile per questa modifica.");
      onMissing?.();
    } else setError("Non riuscito. Riprova.");
  }

  async function askToSuspend() {
    setBusy(true);
    setError(null);
    const commitments = await fetchCommitments();
    setBusy(false);
    setConfirm(commitments ? (commitments.get(item.id) ?? "none") : null);
  }

  return (
    <>
      <span className="inline-flex flex-col items-start gap-1">
        <Button
          type="button"
          variant={item.suspended ? "staff-primary" : "staff-secondary"}
          className="px-3 py-1.5 text-xs"
          disabled={busy}
          aria-pressed={item.suspended}
          onClick={() => void (item.suspended ? apply(false) : askToSuspend())}
        >
          {busy ? "Attendi…" : item.suspended ? "Riattiva" : "Sospendi"}
        </Button>
        {error && (
          <span role="alert" className="text-xs text-(--state-error)">
            {error}
          </span>
        )}
      </span>
      <Modal
        open={confirm !== undefined}
        title={`Sospendere ${item.name}?`}
        dismissible={!busy}
        onClose={() => setConfirm(undefined)}
        actions={
          <>
            <Button variant="staff-secondary" onClick={() => setConfirm(undefined)} disabled={busy}>
              Annulla
            </Button>
            <Button variant="staff-primary" onClick={() => void apply(true)} disabled={busy}>
              {busy ? "Sospendo…" : "Sospendi"}
            </Button>
          </>
        }
      >
        <p className="font-semibold text-(--text-primary)">
          {confirm === null
            ? "Non riesco a contare gli ordini in corso: controlla la coda prima di sospendere."
            : commitmentSummary(confirm === "none" ? undefined : confirm)}
        </p>
        <p className="mt-2">
          Gli ordini già inviati riceveranno comunque questo prodotto: la sospensione vale solo per i nuovi ordini.
        </p>
      </Modal>
    </>
  );
}
