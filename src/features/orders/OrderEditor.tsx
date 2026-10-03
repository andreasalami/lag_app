import type { Dispatch, SetStateAction } from "react";
import { Card } from "../../components/ui/Card";
import { priceFormatter } from "./orderUtils";
import { addToCart, cartTotal, lineTotal, remainingStock, removeOneFromCart, type Cart } from "./cart";
import type { OrderMenuItem } from "./types";

type Props = {
  menuItems: OrderMenuItem[];
  cart: Cart;
  setCart: Dispatch<SetStateAction<Cart>>;
  alias: string;
  setAlias: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
};

export function OrderEditor({ menuItems, cart, setCart, alias, setAlias, notes, setNotes }: Props) {
  const lines = Object.values(cart);
  const total = cartTotal(lines);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="mb-1 block text-xs font-semibold">Alias</span>
          <input
            value={alias}
            maxLength={32}
            onChange={(event) => setAlias(event.target.value)}
            className="field w-full py-2"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs font-semibold">Note cucina</span>
          <input
            value={notes}
            maxLength={300}
            onChange={(event) => setNotes(event.target.value)}
            className="field w-full py-2"
          />
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {menuItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setCart((current) => addToCart(current, item).cart)}
            disabled={remainingStock(cart, item) === 0}
            className="field flex min-h-12 items-center justify-between gap-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-sm">
              {item.name}
              {item.available_portions === 0 ? " — terminato" : ""}
            </span>
            <span className="shrink-0 font-mono text-[var(--accent-primary)]">
              {priceFormatter.format(Number(item.price))}
            </span>
          </button>
        ))}
      </div>

      <Card className="flex flex-col gap-2">
        <h3 className="text-lg">Righe da battere</h3>
        {lines.length === 0 && <p className="text-sm text-[var(--text-secondary)]">Nessuna voce.</p>}
        {lines.map((line) => (
          <div key={line.id} className="flex items-center justify-between gap-3 text-sm">
            <span>
              {line.qty}× {line.name}
            </span>
            <div className="flex items-center gap-3">
              <span className="font-mono">{priceFormatter.format(lineTotal(line))}</span>
              <button
                type="button"
                onClick={() => setCart((current) => removeOneFromCart(current, line.id))}
                className="text-lg text-[var(--state-error)]"
                aria-label={`Rimuovi una unità di ${line.name}`}
              >
                −
              </button>
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
