import { useEffect, useRef, useState } from "react";
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

// I prodotti aggiunti in locale (non ancora salvati) hanno un id
// temporaneo con questo prefisso, mai una vera uuid — così al salvataggio
// sappiamo distinguere "va inserito" da "va aggiornato" senza dover
// confrontare con l'ultimo stato noto del DB riga per riga.
const NEW_ID_PREFIX = "new:";
const isNewId = (id: string) => id.startsWith(NEW_ID_PREFIX);

/*
  Menu — dati Supabase, editing riservato al ruolo 'staff'/'admin'.

  Tutto quello che digiti resta SOLO in locale (in `items`) finché non
  premi "Salva": un'unica chiamata RPC (bulk_upsert_menu_items) applica
  creazioni, modifiche ed eliminazioni in un colpo solo, in una
  transazione atomica — o va tutto a buon fine, o niente cambia.

  `savedItems` è l'ultimo stato noto per certo dal DB (sincronizzato al
  primo caricamento e di nuovo subito dopo un salvataggio riuscito).
  isDirty confronta `items` con `savedItems`: è la versione "semplice"
  (un confronto diretto, non un diff campo per campo) — sufficiente per
  sapere SE mostrare il tasto Salva, non ci serve sapere esattamente
  cosa è cambiato per farlo.
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

  const [savedItems, setSavedItems] = useState<MenuItem[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedOnceRef = useRef(false);

  // Sincronizza lo snapshot "salvato" al primo caricamento vero (non ad
  // ogni render: solo quando la fetch iniziale finisce).
  useEffect(() => {
    if (!loading && !savedOnceRef.current) {
      setSavedItems(items);
      savedOnceRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const isDirty = deletedIds.length > 0 || JSON.stringify(items) !== JSON.stringify(savedItems);

  function addItem(category: Category) {
    setItems((prev) => [
      ...prev,
      { id: `${NEW_ID_PREFIX}${crypto.randomUUID()}`, category, name: "Nuovo prodotto", price: 0, available_portions: null },
    ]);
  }

  function deleteItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    // Un prodotto mai salvato non esiste nel DB: niente da eliminare lì.
    if (!isNewId(id)) setDeletedIds((prev) => [...prev, id]);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);

    const created = items
      .filter((i) => isNewId(i.id))
      .map(({ category, name, price, available_portions }) => ({ category, name, price, available_portions }));

    const updated = items.filter((i) => {
      if (isNewId(i.id)) return false;
      const original = savedItems.find((s) => s.id === i.id);
      return original && JSON.stringify(original) !== JSON.stringify(i);
    });

    const { error } = await supabase.rpc("bulk_upsert_menu_items", {
      p_created: created,
      p_updated: updated,
      p_deleted: deletedIds,
    });

    if (error) {
      console.error("[Menu] Errore salvataggio:", error.message);
      setSaveError("Salvataggio non riuscito. Riprova.");
      setSaving(false);
      return;
    }

    const fresh = await refetch();
    if (fresh) setSavedItems(fresh);
    setDeletedIds([]);
    setSaving(false);
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
                        onChange={(e) => setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, name: e.target.value } : i)))}
                        className="field min-w-0 w-full sm:flex-1"
                      />
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        value={item.price}
                        onChange={(e) => setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, price: Number(e.target.value) } : i)))}
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
                        onChange={(e) => setItems((prev) => prev.map((i) => (i.id === item.id ? {
                          ...i,
                          available_portions: e.target.value === "" ? null : Math.max(0, Number(e.target.value)),
                        } : i)))}
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

      {/* Barra di salvataggio: appare solo con modifiche in sospeso, fissa
          in basso così resta visibile mentre scorri una lista lunga. Non
          è un bottone "in più" da cercare — sei sempre a un tap da salvare
          o sai sempre che hai roba non ancora scritta sul DB. */}
      {canEdit && isDirty && (
        <div className="glass-elevated glass-elevated--strong fixed inset-x-4 bottom-24 z-40 mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-[var(--radius-md)] px-4 py-3">
          <span className="text-xs text-[var(--text-secondary)]">
            {saveError ?? "Ci sono modifiche non ancora salvate."}
          </span>
          <button
            onClick={handleSave}
            disabled={saving}
            className="signature-glow rounded-[var(--radius-pill)] bg-[var(--accent-primary)] px-4 py-2 text-sm font-semibold text-[var(--text-on-accent)] disabled:opacity-50"
          >
            {saving ? "Salvo..." : "Salva"}
          </button>
        </div>
      )}
    </section>
  );
}
