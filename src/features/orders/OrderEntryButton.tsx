import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { supabase } from "../../lib/supabaseClient";
import { orderingReasonMessage } from "./orderUtils";
import type { OrderingStatus } from "./types";

export function OrderEntryButton() {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function enterOrdering() {
    setChecking(true);
    const { data, error } = await supabase.rpc("get_ordering_status");
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
    window.location.hash = "ordina";
  }

  return (
    <>
      <div className="mt-8 text-center">
        <Button variant="primary" onClick={enterOrdering} disabled={checking}>
          {checking ? "Verifico..." : "Ordina qui"}
        </Button>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">Prepara l’ordine e paga in cassa.</p>
      </div>
      <Modal
        open={message !== null}
        title="Ordinazioni non disponibili"
        dismissible
        onClose={() => setMessage(null)}
        actions={<Button variant="primary" onClick={() => setMessage(null)}>Ho capito</Button>}
      >
        <p>{message}</p>
      </Modal>
    </>
  );
}
