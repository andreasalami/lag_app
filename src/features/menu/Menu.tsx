import { Card } from "../../components/ui/Card";
import { useAuth } from "../auth/AuthContext";
import { supabase } from "../../lib/supabaseClient";
import { useSupabaseRows } from "../../lib/useSupabaseRows";

type Category = "cibo" | "bevande";

type MenuItem = {
  id: string;
  category: Category;
  name: string;
  price: number;
  available_portions: number | null;
};

const CATEGORIES: Category[] = ["cibo", "bevande"];
const CATEGORY_LABEL: Record<Category, string> = { cibo: "Cibo", bevande: "Bevande" };

const FALLBACK_ITEMS: MenuItem[] = [
  { id: "f1", category: "cibo", name: "Panino salamella — esempio", price: 5, available_portions: null },
  { id: "f2", category: "cibo", name: "Patatine fritte — esempio", price: 3, available_portions: null },
  { id: "f3", category: "bevande", name: "Birra media — esempio", price: 4, available_portions: null },
  { id: "f4", category: "bevande", name: "Acqua — esempio", price: 1.5, available_portions: null },
];

const priceFormatter = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

/*
  Menu — stesso pattern esatto di Program (vedi useSupabaseRows):
  dati Supabase con realtime, fallback di esempio, editing riservato
  al ruolo 'staff' (identico agli annunci, nessuna autenticazione
  a parte).
*/
export function Menu() {
  const { role } = useAuth();
  const canEdit = role === "staff" || role === "admin";
  const { rows: items, setRows: setItems, loading, refetch } = useSupabaseRows<MenuItem>({
    table: "menu_items",
    select: "id, category, name, price, available_portions",
    orderBy: [
      { column: "category" },
      { column: "name" },
    ],
    fallback: FALLBACK_ITEMS,
  });

  async function addItem(category: Category) {
    const { error } = await supabase.from("menu_items").insert({ category, name: "Nuovo prodotto", price: 0, available_portions: null });
    if (error) console.error("[Menu] Errore inserimento:", error.message);
    refetch();
  }

  async function updateItem(id: string, patch: Partial<MenuItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    const { error } = await supabase.from("menu_items").update(patch).eq("id", id);
    if (error) {
      console.error("[Menu] Errore aggiornamento:", error.message);
      refetch();
    }
  }

  async function deleteItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    const { error } = await supabase.from("menu_items").delete().eq("id", id);
    if (error) {
      console.error("[Menu] Errore eliminazione:", error.message);
      refetch();
    }
  }

  return (
    <section id="menu" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Menu</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">Cibo e bevande disponibili all'evento.</p>

      {loading ? (
        <p className="text-sm text-[var(--text-secondary)]">Carico il menu...</p>
      ) : (
        CATEGORIES.map((category) => (
          <div key={category} className="mb-6">
            <h3 className="mb-2 font-display text-lg">{CATEGORY_LABEL[category]}</h3>
            <Card className="flex flex-col gap-2">
              {items.filter((i) => i.category === category).length === 0 && !canEdit && (
                <p className="text-sm text-[var(--text-secondary)]">Nessun prodotto ancora pubblicato.</p>
              )}
              {items
                .filter((i) => i.category === category)
                .map((item) =>
                  canEdit ? (
                    <div
                      key={item.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-[var(--surface-border)] pb-3 last:border-0 last:pb-0 sm:flex sm:items-center sm:pb-2"
                    >
                      <input
                        value={item.name}
                        onChange={(e) => updateItem(item.id, { name: e.target.value })}
                        className="field min-w-0 w-full sm:flex-1"
                      />
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        value={item.price}
                        onChange={(e) => updateItem(item.id, { price: Number(e.target.value) })}
                        className="field w-full min-w-0 text-right font-mono sm:w-20"
                      />
                      <span className="hidden text-xs text-[var(--text-secondary)] sm:inline">€</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        placeholder="∞"
                        aria-label={`Porzioni disponibili per ${item.name}`}
                        value={item.available_portions ?? ""}
                        onChange={(e) => updateItem(item.id, {
                          available_portions: e.target.value === "" ? null : Math.max(0, Number(e.target.value)),
                        })}
                        className="field w-full min-w-0 text-right font-mono sm:w-20"
                      />
                      <span className="hidden text-xs text-[var(--text-secondary)] sm:inline">porz.</span>
                      <button
                        onClick={() => deleteItem(item.id)}
                        className="justify-self-start text-xs text-[var(--state-error)] hover:underline sm:justify-self-auto"
                      >
                        Elimina
                      </button>
                    </div>
                  ) : (
                    <div key={item.id} className="flex items-center justify-between">
                      <span className="text-sm text-[var(--text-primary)]">{item.name}</span>
                      <span className="font-mono text-sm text-[var(--accent-primary)]">
                        {priceFormatter.format(item.price)}
                      </span>
                    </div>
                  )
                )}
              {canEdit && (
                <button
                  onClick={() => addItem(category)}
                  className="mt-1 self-start text-xs text-[var(--accent-primary)] hover:underline"
                >
                  + Aggiungi prodotto
                </button>
              )}
            </Card>
          </div>
        ))
      )}
    </section>
  );
}
