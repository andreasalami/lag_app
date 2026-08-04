import { useEffect, useState } from "react";
import { Card } from "../../components/ui/Card";
import { RoleLogin } from "../auth/RoleLogin";
import { useAuth } from "../auth/AuthContext";
import { supabase, isSupabaseConfigured } from "../../lib/supabaseClient";

type Category = "cibo" | "bevande";

type MenuItem = {
  id: string;
  category: Category;
  name: string;
  price: number;
};

const CATEGORIES: Category[] = ["cibo", "bevande"];
const CATEGORY_LABEL: Record<Category, string> = { cibo: "Cibo", bevande: "Bevande" };

const FALLBACK_ITEMS: MenuItem[] = [
  { id: "f1", category: "cibo", name: "Panino salamella — esempio", price: 5 },
  { id: "f2", category: "cibo", name: "Patatine fritte — esempio", price: 3 },
  { id: "f3", category: "bevande", name: "Birra media — esempio", price: 4 },
  { id: "f4", category: "bevande", name: "Acqua — esempio", price: 1.5 },
];

const priceFormatter = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

/*
  Menu — stesso pattern esatto di Program: dati Supabase con realtime,
  fallback di esempio, editing riservato al ruolo 'staff' (identico
  agli annunci, nessuna autenticazione a parte).
*/
export function Menu() {
  const { role } = useAuth();
  const canEdit = role === "staff";
  const [items, setItems] = useState<MenuItem[]>(FALLBACK_ITEMS);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  const fetchItems = async () => {
    const { data, error } = await supabase
      .from("menu_items")
      .select("id, category, name, price")
      .order("category", { ascending: true })
      .order("name", { ascending: true });
    if (!error && data) setItems(data);
    setLoading(false);
  };

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    fetchItems();
    const channel = supabase
      .channel("menu-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "menu_items" }, fetchItems)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function addItem(category: Category) {
    await supabase.from("menu_items").insert({ category, name: "Nuovo prodotto", price: 0 });
    fetchItems();
  }

  async function updateItem(id: string, patch: Partial<MenuItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    await supabase.from("menu_items").update(patch).eq("id", id);
  }

  async function deleteItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    await supabase.from("menu_items").delete().eq("id", id);
  }

  return (
    <section id="menu" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">Menu</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">Cibo e bevande disponibili all'evento.</p>

      <RoleLogin requiredRole="staff" label="Staff" />

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
                      className="flex items-center gap-2 border-b border-[var(--surface-border)] pb-2 last:border-0 last:pb-0"
                    >
                      <input
                        value={item.name}
                        onChange={(e) => updateItem(item.id, { name: e.target.value })}
                        className="flex-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-transparent px-2 py-1 text-sm text-[var(--text-primary)]"
                      />
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        value={item.price}
                        onChange={(e) => updateItem(item.id, { price: Number(e.target.value) })}
                        className="w-20 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-transparent px-2 py-1 text-right font-mono text-sm text-[var(--text-primary)]"
                      />
                      <span className="text-xs text-[var(--text-secondary)]">€</span>
                      <button
                        onClick={() => deleteItem(item.id)}
                        className="text-xs text-[var(--state-error)] hover:underline"
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
