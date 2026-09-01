import { useEffect, useRef, useState } from "react";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { SaveBanner } from "../../components/ui/SaveBanner";
import { useAuth } from "../auth/AuthContext";
import { supabase } from "../../lib/supabaseClient";
import { useSupabaseRows } from "../../lib/useSupabaseRows";
import { ALLERGENS, priceFormatter } from "../orders/orderUtils";
import { OrderEntryButton } from "../orders/OrderEntryButton";
import { MENU_SECTIONS, menuSectionFor, type MenuCategory } from "./menuSections";

type Category = MenuCategory;

type MenuItem = {
  id: string;
  category: Category;
  name: string;
  price: number;
  available_portions: number | null;
  stock_capacity: number | null;
  allergens: number[];
};

const CATEGORIES: Category[] = ["cibo", "bevande"];
const CATEGORY_LABEL: Record<Category, string> = { cibo: "Cucina", bevande: "Bar" };
const CATEGORY_DESCRIPTION: Record<Category, string> = {
  cibo: "Piatti preparati durante l’evento",
  bevande: "Birre, vini, drinks e analcolici",
};

const FALLBACK_ITEMS: MenuItem[] = [
  { id: "f1", category: "cibo", name: "Panino salamella — esempio", price: 5, available_portions: null, stock_capacity: null, allergens: [1] },
  { id: "f2", category: "cibo", name: "Patatine fritte — esempio", price: 3, available_portions: null, stock_capacity: null, allergens: [] },
  { id: "f3", category: "bevande", name: "Birra media — esempio", price: 4, available_portions: null, stock_capacity: null, allergens: [1] },
  { id: "f4", category: "bevande", name: "Acqua — esempio", price: 1.5, available_portions: null, stock_capacity: null, allergens: [] },
];

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
export function Menu({ management = false }: { management?: boolean }) {
  const { role } = useAuth();
  const canManage = role === "staff" || role === "cucina" || role === "admin";
  const canEdit = management && canManage;
  const { rows: items, setRows: setItems, loading, error: loadError, refetch } = useSupabaseRows<MenuItem>({
    table: "menu_items",
    select: "id, category, name, price, available_portions, stock_capacity, allergens",
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
      {
        id: `${NEW_ID_PREFIX}${crypto.randomUUID()}`,
        category,
        name: "Nuovo prodotto",
        price: 0,
        available_portions: null,
        stock_capacity: null,
        allergens: [],
      },
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

    const invalidItem = items.some((item) =>
      !item.name.trim()
      || item.name.length > 200
      || !Number.isFinite(item.price)
      || item.price < 0
      || item.price > 9999.99
      || item.allergens.some((allergen) => !Number.isInteger(allergen) || allergen < 1 || allergen > 14)
      || new Set(item.allergens).size !== item.allergens.length
      || (item.available_portions !== null
        && (!Number.isInteger(item.available_portions) || item.available_portions < 0))
    );
    if (invalidItem) {
      setSaveError("Controlla nomi, prezzi e porzioni: alcuni valori non sono validi.");
      setSaving(false);
      return;
    }

    const created = items
      .filter((i) => isNewId(i.id))
      .map(({ category, name, price, available_portions, allergens }) => ({
        category,
        name,
        price,
        available_portions,
        allergens,
      }));

    const updated = items.flatMap((item) => {
      if (isNewId(item.id)) return [];
      const original = savedItems.find((saved) => saved.id === item.id);
      if (!original || JSON.stringify(original) === JSON.stringify(item)) return [];
      return [{ ...item, original_available_portions: original.available_portions }];
    });

    const { error } = await supabase.rpc("bulk_upsert_menu_items", {
      p_created: created,
      p_updated: updated,
      p_deleted: deletedIds,
    });

    if (error) {
      console.error("[Menu] Errore salvataggio:", error.message);
      setSaveError(error.message.includes("stock_changed_retry")
        ? "Le scorte sono cambiate per un nuovo ordine. Ricarica la pagina e ripeti la modifica."
        : "Salvataggio non riuscito. Riprova.");
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
      <h2 className="mb-1 text-2xl font-semibold">{management ? "Gestione Menu e Scorte" : "Menu"}</h2>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">
        {management ? "Aggiorna prodotti, prezzi, disponibilità e allergeni." : "Cucina e Bar disponibili durante l’evento."}
      </p>

      {!management && canManage && (
        <Button href={`${import.meta.env.BASE_URL}#gestione-menu`} className="mb-5 w-full justify-start sm:w-64">
          Gestione Menu e Scorte
        </Button>
      )}

      {loadError ? (
        <p className="text-sm text-[var(--state-error)]">Menu non disponibile. Ricarica la pagina.</p>
      ) : loading ? (
        <p className="text-sm text-[var(--text-secondary)]">Carico il menu...</p>
      ) : (
        CATEGORIES.map((category) => (
          <Card key={category} className="mb-6 overflow-hidden !p-0">
            <div className="border-b border-[var(--surface-border)] bg-[linear-gradient(135deg,rgba(242,128,46,0.16),transparent_65%)] px-5 py-5 sm:px-6">
              <p className="text-xs uppercase tracking-[0.16em] text-[var(--text-secondary)]">Menu dell’evento</p>
              <h3 className="mt-1 font-display text-2xl text-[var(--accent-primary)]">{CATEGORY_LABEL[category]}</h3>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">{CATEGORY_DESCRIPTION[category]}</p>
            </div>

            <div className="px-4 py-2 sm:px-6">
              {MENU_SECTIONS[category].map((section) => {
                const sectionItems = items.filter((item) =>
                  item.category === category && menuSectionFor(category, item.name) === section.key
                );

                return (
                  <div key={section.key} className="border-b border-[var(--surface-border)] py-4 last:border-0">
                    <h4 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">{section.label}</h4>
                    {sectionItems.length === 0 ? (
                      <p className="text-sm text-[var(--text-secondary)]">Nessuna proposta al momento.</p>
                    ) : (
                      <div className="space-y-3">
                        {sectionItems.map((item) => canEdit ? (
                          <div key={item.id} className="border-b border-[var(--surface-border)] pb-3 last:border-0 last:pb-0">
                            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:flex sm:items-center">
                              <input
                                required
                                maxLength={200}
                                value={item.name}
                                onChange={(e) => setItems((prev) => prev.map((candidate) => candidate.id === item.id ? { ...candidate, name: e.target.value } : candidate))}
                                className="field min-w-0 w-full sm:flex-1"
                              />
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                max="9999.99"
                                aria-label={`Prezzo di ${item.name}`}
                                value={item.price}
                                onChange={(e) => setItems((prev) => prev.map((candidate) => candidate.id === item.id ? { ...candidate, price: Number(e.target.value) } : candidate))}
                                className="field w-full min-w-0 text-right font-mono sm:w-20"
                              />
                              <input
                                type="number"
                                min="0"
                                step="1"
                                placeholder="∞"
                                aria-label={`Porzioni disponibili per ${item.name}`}
                                value={item.available_portions ?? ""}
                                onChange={(e) => setItems((prev) => prev.map((candidate) => candidate.id === item.id ? {
                                  ...candidate,
                                  available_portions: e.target.value === "" ? null : Number(e.target.value),
                                } : candidate))}
                                className="field w-full min-w-0 text-right font-mono sm:w-24"
                              />
                              <button type="button" onClick={() => deleteItem(item.id)} className="justify-self-start text-xs text-[var(--state-error)] hover:underline sm:justify-self-auto">
                                Elimina
                              </button>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`Allergeni di ${item.name}`}>
                              {ALLERGENS.map((allergen, index) => {
                                const number = index + 1;
                                const selected = item.allergens.includes(number);
                                return (
                                  <button
                                    key={allergen}
                                    type="button"
                                    title={`${number}. ${allergen}`}
                                    aria-pressed={selected}
                                    onClick={() => setItems((prev) => prev.map((candidate) => candidate.id === item.id ? {
                                      ...candidate,
                                      allergens: selected
                                        ? candidate.allergens.filter((value) => value !== number)
                                        : [...candidate.allergens, number].sort((a, b) => a - b),
                                    } : candidate))}
                                    className={`h-7 w-7 rounded-full border text-xs ${selected
                                      ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--text-on-accent)]"
                                      : "border-[var(--surface-border)] text-[var(--text-secondary)]"}`}
                                  >
                                    {number}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <div key={item.id} className="flex items-start justify-between gap-3">
                            <span className="text-sm text-[var(--text-primary)]">
                              {item.name}
                              {item.allergens.length > 0 && (
                                <span className="ml-2 text-xs text-[var(--text-secondary)]">Allergeni: {item.allergens.join(", ")}</span>
                              )}
                            </span>
                            <span className="shrink-0 font-mono text-sm text-[var(--accent-primary)]">{priceFormatter.format(item.price)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {canEdit && (
                <button onClick={() => addItem(category)} className="mb-4 mt-2 text-xs text-[var(--accent-primary)] hover:underline">
                  + Aggiungi prodotto in {CATEGORY_LABEL[category]}
                </button>
              )}

              {category === "bevande" && (
                <div className="mb-4 rounded-[var(--radius-md)] border border-[var(--accent-primary)]/40 bg-[rgba(242,128,46,0.08)] px-4 py-3 text-sm font-semibold text-[var(--accent-primary)]">
                  Acqua Gratis
                </div>
              )}
            </div>
          </Card>
        ))
      )}

      {!management && <OrderEntryButton />}

      {/* Banner di salvataggio condiviso (vedi SaveBanner.tsx): appare solo
          con modifiche in sospeso, fisso in basso così resta visibile
          mentre scorri una lista lunga. Non è un bottone "in più" da
          cercare — sei sempre a un tap da salvare o sai sempre che hai
          roba non ancora scritta sul DB. Stesso identico banner in
          Programma e Torneo, così il gesto è sempre lo stesso. */}
      {canEdit && isDirty && (
        <SaveBanner
          message="Ci sono modifiche al Menu non ancora salvate."
          saving={saving}
          error={saveError}
          onSave={handleSave}
        />
      )}
    </section>
  );
}
