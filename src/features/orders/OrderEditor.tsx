import type { Dispatch, SetStateAction } from "react";
import { Card } from "../../components/ui/Card";
import { priceFormatter } from "./orderUtils";
import type { OrderLine, OrderMenuItem } from "./types";

type Props = {
  menuItems: OrderMenuItem[];
  cart: Record<string, OrderLine>;
  setCart: Dispatch<SetStateAction<Record<string, OrderLine>>>;
  alias: string;
  setAlias: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
};

export function OrderEditor({ menuItems, cart, setCart, alias, setAlias, notes, setNotes }: Props) {
  const lines = Object.values(cart);
  const total = lines.reduce((sum, line) => sum + Number(line.price) * line.qty, 0);

  function addItem(item: OrderMenuItem) {
    setCart((current) => {
      const existing = current[item.id];
      return {
        ...current,
        [item.id]: {
          id: item.id,
          category: item.category,
          subcategory: item.subcategory,
          name: item.name,
          price: Number(item.price),
          qty: (existing?.qty ?? 0) + 1,
          allergens: item.allergens ?? [],
        },
      };
    });
  }

  function decrement(id: string) {
    setCart((current) => {
      const line = current[id];
      if (!line) return current;
      if (line.qty <= 1) {
        const { [id]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [id]: { ...line, qty: line.qty - 1 } };
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="mb-1 block text-xs font-semibold">Alias</span>
          <input value={alias} maxLength={32} onChange={(event) => setAlias(event.target.value)} className="field w-full py-2" />
        </label>
        <label>
          <span className="mb-1 block text-xs font-semibold">Note cucina</span>
          <input value={notes} maxLength={300} onChange={(event) => setNotes(event.target.value)} className="field w-full py-2" />
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {menuItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => addItem(item)}
            disabled={item.available_portions === 0 && !cart[item.id]}
            className="field flex min-h-12 items-center justify-between gap-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-sm">{item.name}{item.available_portions === 0 ? " — terminato" : ""}</span>
            <span className="shrink-0 font-mono text-[var(--accent-primary)]">{priceFormatter.format(Number(item.price))}</span>
          </button>
        ))}
      </div>

      <Card className="flex flex-col gap-2">
        <h3 className="text-lg">Righe da battere</h3>
        {lines.length === 0 && <p className="text-sm text-[var(--text-secondary)]">Nessuna voce.</p>}
        {lines.map((line) => (
          <div key={line.id} className="flex items-center justify-between gap-3 text-sm">
            <span>{line.qty}× {line.name}</span>
            <div className="flex items-center gap-3">
              <span className="font-mono">{priceFormatter.format(Number(line.price) * line.qty)}</span>
              <button type="button" onClick={() => decrement(line.id)} className="text-lg text-[var(--state-error)]" aria-label={`Rimuovi una unità di ${line.name}`}>−</button>
            </div>
          </div>
        ))}
        <div className="mt-2 flex justify-between border-t border-[var(--surface-border)] pt-2 font-semibold">
          <span>Totale</span>
          <span className="font-mono">{priceFormatter.format(total)}</span>
        </div>
      </Card>
    </div>
  );
}
