import { useLayoutEffect, useRef } from "react";
import { Button } from "../../components/ui/Button";
import { cartItemCount, lineTotal } from "./cart";
import { priceFormatter } from "./orderUtils";
import type { OrderLine } from "./types";

type Props = {
  lines: OrderLine[];
  total: number;
  expanded: boolean;
  onToggle: () => void;
  onDecrement: (id: string) => void;
  notes: string;
  onNotesChange: (notes: string) => void;
  error: string | null;
  onSubmit: () => void;
  /** Altezza del carrello fisso, perché la pagina lasci lo spazio per non coprire il menu. */
  onHeightChange: (height: number) => void;
};

/** Carrello fisso in basso: si apre per vedere righe, note e invio. */
export function CartPanel({
  lines,
  total,
  expanded,
  onToggle,
  onDecrement,
  notes,
  onNotesChange,
  error,
  onSubmit,
  onHeightChange,
}: Props) {
  const panel = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const measure = () => onHeightChange(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      onHeightChange(0);
    };
  }, [onHeightChange]);

  return (
    <section
      ref={panel}
      className="glass-elevated fixed inset-x-3 z-50 mx-auto max-w-xl rounded-[var(--radius-lg)] p-3"
      style={{ bottom: "calc(12px + env(safe-area-inset-bottom, 0px))" }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={expanded}
      >
        <span className="font-semibold">Carrello · {cartItemCount(lines)} articoli</span>
        <span className="font-mono text-[var(--accent-primary)]">
          {priceFormatter.format(total)} {expanded ? "⌄" : "⌃"}
        </span>
      </button>
      {expanded && (
        <div className="mt-3 max-h-[50dvh] overflow-y-auto overscroll-contain border-t border-[var(--surface-border)] pt-3">
          <div className="flex flex-col gap-2">
            {lines.map((line) => (
              <div key={line.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {line.qty}× {line.name}
                </span>
                <div className="flex items-center gap-3">
                  <span className="font-mono">{priceFormatter.format(lineTotal(line))}</span>
                  <button
                    type="button"
                    onClick={() => onDecrement(line.id)}
                    className="text-lg text-[var(--state-error)]"
                    aria-label={`Rimuovi una unità di ${line.name}`}
                  >
                    −
                  </button>
                </div>
              </div>
            ))}
          </div>
          <label className="mt-3 block">
            <span className="text-xs font-semibold">Note per la cucina</span>
            <textarea
              value={notes}
              onChange={(event) => onNotesChange(event.target.value)}
              maxLength={300}
              rows={2}
              placeholder="Es. senza cipolla. Non inserire dati personali."
              className="field mt-1 w-full resize-none"
            />
          </label>
          {error && <p className="mt-2 text-xs text-[var(--state-error)]">{error}</p>}
          <Button variant="primary" className="mt-3 w-full" onClick={onSubmit}>
            Invia ordine
          </Button>
        </div>
      )}
    </section>
  );
}
