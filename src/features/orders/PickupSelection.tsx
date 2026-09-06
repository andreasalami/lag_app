import { useId } from "react";
import "./orderControls.css";
import { Button } from "../../components/ui/Button";
import {
  isPickupSelectionValid,
  remainingPickupSelection,
  remainingToPickUp,
  selectedPickupCount,
  type PickupItem,
} from "./pickupQuantities";

type Props = {
  items: PickupItem[];
  selection: Record<string, number>;
  onChange: (selection: Record<string, number>) => void;
  onConfirm: () => void;
  busy?: boolean;
};

export function PickupSelection({ items, selection, onChange, onConfirm, busy = false }: Props) {
  const labelId = useId();
  const selected = selectedPickupCount(selection);
  const valid = isPickupSelectionValid(items, selection);
  const totalRemaining = items.reduce((total, item) => total + remainingToPickUp(item), 0);
  const selectedItems = items.filter(item => (selection[item.id] ?? 0) > 0);
  const confirmation = selectedItems.length === 1
    ? `Consegna ${selected} × ${selectedItems[0].name}`
    : `Consegna ${selected} articoli`;

  function setQuantity(id: string, value: number) {
    onChange({ ...selection, [id]: value });
  }

  return (
    <div className="pickup-selector">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id={labelId} className="text-lg">Quanto consegni adesso?</h2>
        <button type="button" disabled={busy || totalRemaining === 0} onClick={() => onChange(remainingPickupSelection(items))} className="order-quiet-action">Seleziona tutto</button>
      </div>
      <div className="space-y-3" aria-labelledby={labelId}>
        {items.map((item) => {
          const remaining = remainingToPickUp(item);
          const quantity = selection[item.id] ?? 0;
          return (
            <fieldset key={item.id} disabled={busy || remaining === 0} className="pickup-card" data-selected={quantity > 0}>
              <legend className="sr-only">Ritiro {item.name}</legend>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-sans text-base font-semibold">{item.name}</h3>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">{item.quantity} ordinati · {item.delivered_quantity} già ritirati</p>
                </div>
                <span className="order-badge">{remaining} rimasti</span>
              </div>
              <div className="mt-4 flex flex-col gap-3">
                <div className="order-stepper pickup-main-stepper">
                  <button type="button" disabled={busy || quantity <= 0} aria-label={`Riduci ritiro ${item.name}`} onClick={() => setQuantity(item.id, Math.max(0, quantity - 1))} className="order-stepper-button">−</button>
                  <div className="flex flex-col items-center py-2">
                    <output aria-live="polite" aria-label={`${item.name}: quantità da consegnare`} className="font-mono text-3xl font-semibold">{quantity}</output>
                    <span className="text-xs text-[var(--text-secondary)]">da consegnare ora</span>
                  </div>
                  <button type="button" disabled={busy || quantity >= remaining} aria-label={`Aumenta ritiro ${item.name}`} onClick={() => setQuantity(item.id, quantity + 1)} className="order-stepper-button">+</button>
                </div>
                <div className="flex justify-center gap-2">
                  {[1, 2].map((amount) => (
                    <button key={amount} type="button" aria-label={`${item.name}: consegna ${amount}`} aria-pressed={quantity === amount} disabled={busy || remaining < amount} onClick={() => setQuantity(item.id, amount)} className="pickup-quick">{amount}</button>
                  ))}
                  <button type="button" aria-label={`${item.name}: consegna tutti i ${remaining} rimasti`} aria-pressed={remaining > 0 && quantity === remaining} onClick={() => setQuantity(item.id, remaining)} className="pickup-quick">Tutti</button>
                </div>
              </div>
              <p className="mt-3 text-xs text-[var(--text-secondary)]">{quantity > 0 ? <>Dopo questo ritiro: <strong className="text-[var(--text-primary)]">{Math.max(0, remaining - quantity)} da ritirare</strong></> : "Nessuno da consegnare adesso"}</p>
            </fieldset>
          );
        })}
      </div>
      {!valid && (
        <div role="alert" className="mt-4 rounded-xl border border-[var(--state-error)]/50 p-3 text-sm">
          Le quantità sono cambiate da un’altra postazione. <button type="button" disabled={busy} className="order-quiet-action" onClick={() => onChange({})}>Scegli di nuovo</button>
        </div>
      )}
      <div className="mt-5 border-t border-[var(--surface-border)] pt-4">
        <div className="mb-3 flex min-h-11 items-center justify-between gap-3">
          <p aria-live="polite" className="text-sm text-[var(--text-secondary)]">{selected === 0 ? "Scegli le quantità da consegnare." : `${selected} ${selected === 1 ? "articolo selezionato" : "articoli selezionati"}`}</p>
          {selected > 0 && <button type="button" disabled={busy} className="order-quiet-action" onClick={() => onChange({})}>Azzera</button>}
        </div>
        <Button type="button" variant="staff-primary" className="pickup-confirm min-h-14 w-full whitespace-normal text-base" onClick={onConfirm} disabled={busy || selected === 0 || !valid}>{busy ? "Registro il ritiro…" : selected > 0 ? confirmation : "Conferma ritiro"}</Button>
        <p className="mt-3 text-center text-xs leading-relaxed text-[var(--text-secondary)]">Gli altri prodotti restano disponibili sullo stesso QR.</p>
      </div>
    </div>
  );
}
