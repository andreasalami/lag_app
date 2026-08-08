import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { RoleLogin } from "../auth/RoleLogin";
import { supabase } from "../../lib/supabaseClient";
import { useSupabaseRows } from "../../lib/useSupabaseRows";
import { Card } from "../../components/ui/Card";

type MenuItem = { id: string; category: "cibo" | "bevande"; name: string; price: number; available_portions: number | null };
type CartLine = { id: string; name: string; price: number; qty: number };
type OrderResult = { queue_number: number; warnings: string[] };

const priceFormatter = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

/*
  Cassa: interfaccia interna (non è nel menu pubblico, si accede
  solo su /cassa con login staff ruolo 'cassa'). Conferma ordine
  = un solo INSERT su `orders`, che arriva in cucina via realtime
  nello stesso istante — mentre il cliente sta ancora pagando, in
  cucina hanno già l'ordine davanti.

  Il menu qui viene letto con lo stesso useSupabaseRows già usato
  altrove: realtime attivo, ma essendo 1-2 dispositivi cassa (non
  3000 utenti) non è un problema di scala, è comodo e basta.
*/
export function Cassa() {
  const { role } = useAuth();
  const { rows: menuItems, loading } = useSupabaseRows<MenuItem>({
    table: "menu_items",
    select: "id, category, name, price, available_portions",
    orderBy: [{ column: "category" }, { column: "name" }],
    fallback: [],
  });

  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [submitting, setSubmitting] = useState(false);
  const [lastQueueNumber, setLastQueueNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  if (role !== "cassa" && role !== "admin") {
    return (
      <section className="mx-auto max-w-3xl px-4 py-10">
        <h2 className="mb-4 text-2xl font-semibold">Cassa</h2>
        <RoleLogin requiredRole="cassa" label="Cassa" />
      </section>
    );
  }

  function addToCart(item: MenuItem) {
    setCart((prev) => {
      const existing = prev[item.id];
      return {
        ...prev,
        [item.id]: { id: item.id, name: item.name, price: item.price, qty: (existing?.qty ?? 0) + 1 },
      };
    });
  }

  function decrementFromCart(id: string) {
    setCart((prev) => {
      const existing = prev[id];
      if (!existing) return prev;
      if (existing.qty <= 1) {
        const { [id]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: { ...existing, qty: existing.qty - 1 } };
    });
  }

  const lines = Object.values(cart);
  const total = lines.reduce((sum, l) => sum + l.price * l.qty, 0);

  async function confirmOrder() {
    if (lines.length === 0) return;
    setSubmitting(true);
    setError(null);
    setWarnings([]);

    const { data, error: insertError } = await supabase.rpc("create_order", {
      p_items: lines.map((l) => ({ id: l.id, qty: l.qty })),
    });

    setSubmitting(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    const result = data as OrderResult;
    setLastQueueNumber(Number(result.queue_number));
    setWarnings(result.warnings ?? []);
    setCart({});
  }

  return (
    <section className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Cassa</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        Componi l'ordine e conferma: arriva subito in cucina.
      </p>

      <RoleLogin requiredRole="cassa" label="Cassa" />

      {lastQueueNumber !== null && (
        <div className="mb-4 rounded-[var(--radius-md)] border border-[var(--accent-primary)] px-3 py-2 text-sm">
          Ordine #{lastQueueNumber} inviato in cucina.
        </div>
      )}
      {warnings.length > 0 && (
        <div className="mb-4 rounded-[var(--radius-md)] border border-[var(--state-warning)] px-3 py-2 text-sm text-[var(--state-warning)]">
          {warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[var(--text-secondary)]">Carico il menu...</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {menuItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => addToCart(item)}
              className="field flex items-center justify-between text-left"
            >
              <span>{item.name}</span>
              <span className="font-mono text-[var(--accent-primary)]">{priceFormatter.format(item.price)}</span>
            </button>
          ))}
        </div>
      )}

      <Card className="mt-6 flex flex-col gap-2">
        <h3 className="font-display text-lg">Ordine corrente</h3>

        {lines.length === 0 && (
          <p className="text-sm text-[var(--text-secondary)]">Nessun articolo selezionato.</p>
        )}

        {lines.map((l) => (
          <div key={l.id} className="flex items-center justify-between text-sm">
            <span>
              {l.qty}× {l.name}
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono">{priceFormatter.format(l.price * l.qty)}</span>
              <button
                type="button"
                onClick={() => decrementFromCart(l.id)}
                className="text-xs text-[var(--state-error)] hover:underline"
              >
                −
              </button>
            </div>
          </div>
        ))}

        {lines.length > 0 && (
          <>
            <div className="mt-2 flex items-center justify-between border-t border-[var(--surface-border)] pt-2 font-semibold">
              <span>Totale</span>
              <span className="font-mono">{priceFormatter.format(total)}</span>
            </div>
            <button
              type="button"
              onClick={confirmOrder}
              disabled={submitting}
              className="signature-glow glass-elevated glass-elevated--strong mt-2 rounded-[var(--radius-pill)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {submitting ? "Invio..." : "Conferma ordine"}
            </button>
          </>
        )}

        {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
      </Card>
    </section>
  );
}
