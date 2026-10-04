import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { supabase } from "../../lib/supabaseClient";
import { orderingReasonMessage } from "./orderUtils";
import type { OrderingStatus } from "./types";
import "./orderEntryButton.css";

// Il riempimento dura almeno quanto l'animazione: con una rete veloce il tap non "salta".
const MIN_FILL_MS = 500;

export function OrderEntryButton() {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function enterOrdering() {
    if (checking) return;
    setChecking(true);
    const [{ data, error }] = await Promise.all([
      supabase.rpc("get_ordering_status"),
      new Promise((resolve) => setTimeout(resolve, MIN_FILL_MS)),
    ]);
    setChecking(false);
    if (error || !data) {
      setMessage("Non riesco a verificare le ordinazioni. Controlla la connessione e riprova.");
      return;
    }
    const status = data as OrderingStatus;
    if (!status.accepting) {
      setMessage(orderingReasonMessage(status.reason, status.opens_at));
      return;
    }
    window.location.hash = "ordina-nuovo";
  }

  return (
    <>
      {/* La call to action principale: arancione pieno, prima delle portate. Il riempimento
          è anche l'indicatore di caricamento mentre si verifica se gli ordini sono aperti. */}
      <div className="mb-6 text-center">
        <button
          type="button"
          onClick={() => void enterOrdering()}
          aria-busy={checking}
          className={`order-entry-button${checking ? " is-checking" : ""}`}
        >
          <span className="order-entry-button__fill" aria-hidden="true" />
          <span className="order-entry-button__label">{checking ? "Verifico…" : "Ordina qui"}</span>
        </button>
        <p className="mt-2 text-xs text-(--text-secondary)">Prepara l’ordine e paga in cassa.</p>
      </div>
      <Modal
        open={message !== null}
        title="Ordinazioni non disponibili"
        dismissible
        onClose={() => setMessage(null)}
        actions={
          <Button variant="primary" onClick={() => setMessage(null)}>
            Ho capito
          </Button>
        }
      >
        <p>{message}</p>
      </Modal>
    </>
  );
}
