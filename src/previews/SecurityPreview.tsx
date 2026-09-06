import { useState } from "react";
import { RecoveryCard } from "../features/orders/RecoveryCard";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";

// Production components with synthetic data; this entry never imports Supabase.
export function SecurityPreview() {
  const [open, setOpen] = useState(false);
  return <>
    <p className="px-4 pt-3 text-center text-xs text-[var(--text-secondary)]">Anteprima locale · QR dimostrativo, senza ordini associati</p>
    <RecoveryCard token={"A".repeat(43)} eventName="L’Agro ai Giovani · Evento di esempio" onBack={() => setOpen(true)}/>
    <div className="mx-auto max-w-md px-4 pb-8"><Button className="w-full" onClick={() => setOpen(true)}>Prova finestra di conferma</Button></div>
    <Modal open={open} title="Conferma definitiva" dismissible onClose={() => setOpen(false)} actions={<><Button variant="ghost" onClick={() => setOpen(false)}>Torna al carrello</Button><Button onClick={() => setOpen(false)}>Conferma di esempio</Button></>}>
      <p>Controlla prodotti e quantità. L’ordine non pagato scade dopo 60 minuti.</p>
      <p className="mt-2 font-semibold">Totale da pagare in cassa: 9,00 €</p>
    </Modal>
  </>;
}
