import { useState } from "react";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { SaveBanner } from "../../components/ui/SaveBanner";
import { useAuth } from "../auth/AuthContext";
import { canOpen, staffPage } from "../auth/staffPages";
import { supabase } from "../../lib/supabaseClient";
import { useSupabaseRows } from "../../lib/useSupabaseRows";
import { newDraftId, useDraftRows } from "../../lib/useDraftRows";
import { ALLERGENS, priceFormatter } from "../orders/orderUtils";
import { OrderEntryButton } from "../orders/OrderEntryButton";
import type { OrderMenuItem } from "../orders/types";
import { FreeWaterNotice } from "./FreeWaterNotice";
import { MENU_SECTIONS, isMenuSectionForCategory, type MenuCategory, type MenuSection } from "./menuSections";
import { appHref } from "../../lib/browser";

type Category = MenuCategory;

// Stessa forma dei prodotti usati dagli ordini.
type MenuItem = OrderMenuItem;

const CATEGORIES: Category[] = ["cibo", "bevande"];
const CATEGORY_LABEL: Record<Category, string> = { cibo: "Cucina", bevande: "Bar" };
const CATEGORY_DESCRIPTION: Record<Category, string> = {
  cibo: "Piatti preparati durante l’evento",
  bevande: "Birre, vini, drinks e analcolici",
};

const FALLBACK_ITEMS: MenuItem[] = [
  {
    id: "f1",
    category: "cibo",
    subcategory: "secondi",
    name: "Panino salamella — esempio",
    price: 5,
    available_portions: null,
    stock_capacity: null,
    allergens: [1],
  },
  {
    id: "f2",
    category: "cibo",
    subcategory: "contorni",
    name: "Patatine fritte — esempio",
    price: 3,
    available_portions: null,
    stock_capacity: null,
    allergens: [],
  },
  {
    id: "f3",
    category: "bevande",
    subcategory: "birre",
    name: "Birra media — esempio",
    price: 4,
    available_portions: null,
    stock_capacity: null,
    allergens: [1],
  },
  {
    id: "f4",
    category: "bevande",
    subcategory: "bevande",
    name: "Acqua — esempio",
    price: 1.5,
    available_portions: null,
    stock_capacity: null,
    allergens: [],
  },
];

/*
  Menu — dati Supabase, editing riservato al ruolo 'staff'/'admin'.

  Tutto quello che digiti resta SOLO in locale (in `items`) finché non
  premi "Salva": un'unica chiamata RPC (bulk_upsert_menu_items) applica
  creazioni, modifiche ed eliminazioni in un colpo solo, in una
  transazione atomica — o va tutto a buon fine, o niente cambia.

  La bozza (righe nuove, modificate, eliminate) è gestita da useDraftRows,
  condiviso con il Programma.
*/
export function Menu({ management = false }: { management?: boolean }) {
  const { role } = useAuth();
  const menuPage = staffPage("gestione-menu");
  const canManage = menuPage !== undefined && canOpen(menuPage, role);
  const canEdit = management && canManage;
  // Il bar gestisce solo le bevande: nella gestione vede e sposta soltanto quelle (lo impone anche l'RLS).
  const categories: Category[] = management && role === "bar" ? ["bevande"] : CATEGORIES;
  const {
    rows: items,
    setRows: setItems,
    loading,
    error: loadError,
    refetch,
  } = useSupabaseRows<MenuItem>({
    table: "menu_items",
    select: "id, category, subcategory, name, price, available_portions, stock_capacity, allergens",
    orderBy: [{ column: "category" }, { column: "name" }],
    fallback: FALLBACK_ITEMS,
  });

  const draft = useDraftRows(items, setItems, loading);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function addItem(category: Category, subcategory: MenuSection) {
    setItems((prev) => [
      ...prev,
      {
        id: newDraftId(),
        category,
        subcategory,
        name: "Nuovo prodotto",
        price: 0,
        available_portions: null,
        stock_capacity: null,
        allergens: [],
      },
    ]);
  }

  function moveItem(id: string, value: string) {
    const [category, subcategory] = value.split(":") as [Category, MenuSection];
    if (!CATEGORIES.includes(category) || !isMenuSectionForCategory(category, subcategory)) return;
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, category, subcategory } : item)));
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);

    const invalidItem = items.some(
      (item) =>
        !item.name.trim() ||
        item.name.length > 200 ||
        !Number.isFinite(item.price) ||
        item.price < 0 ||
        item.price > 9999.99 ||
        !isMenuSectionForCategory(item.category, item.subcategory) ||
        item.allergens.some((allergen) => !Number.isInteger(allergen) || allergen < 1 || allergen > 14) ||
        new Set(item.allergens).size !== item.allergens.length ||
        (item.available_portions !== null &&
          (!Number.isInteger(item.available_portions) || item.available_portions < 0)),
    );
    if (invalidItem) {
      setSaveError("Controlla nomi, prezzi e porzioni: alcuni valori non sono validi.");
      setSaving(false);
      return;
    }

    const created = draft.created.map(({ category, subcategory, name, price, available_portions, allergens }) => ({
      category,
      subcategory,
      name,
      price,
      available_portions,
      allergens,
    }));
    // Le porzioni originali permettono al database di accorgersi se un ordine le ha cambiate nel frattempo.
    const updated = draft.updated.map(({ row, original }) => ({
      ...row,
      original_available_portions: original.available_portions,
    }));

    const { error } = await supabase.rpc("bulk_upsert_menu_items", {
      p_created: created,
      p_updated: updated,
      p_deleted: draft.deletedIds,
    });

    if (error) {
      console.error("[Menu] Errore salvataggio:", error.message);
      setSaveError(
        error.message.includes("stock_changed_retry")
          ? "Le scorte sono cambiate per un nuovo ordine. Ricarica la pagina e ripeti la modifica."
          : "Salvataggio non riuscito. Riprova.",
      );
      setSaving(false);
      return;
    }

    draft.markSaved(await refetch());
    setSaving(false);
  }

  return (
    <section id="menu" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">{management ? "Gestione Menu e Scorte" : "Menu"}</h2>
      <p className="mb-4 text-sm text-(--text-secondary)">
        {management
          ? "Aggiorna prodotti, prezzi, disponibilità e allergeni."
          : "Cucina e Bar disponibili durante l’evento."}
      </p>

      {!management && canManage && (
        <Button href={appHref("#gestione-menu")} className="mb-5 w-full justify-start sm:w-64">
          Gestione Menu e Scorte
        </Button>
      )}

      {loadError ? (
        <p className="text-sm text-(--state-error)">Menu non disponibile. Ricarica la pagina.</p>
      ) : loading ? (
        <p className="text-sm text-(--text-secondary)">Carico il menu...</p>
      ) : (
        categories.map((category) => (
          <Card key={category} className="mb-6 overflow-hidden p-0!">
            <div className="panel-header">
              <p className="text-xs uppercase tracking-[0.16em] text-(--text-secondary)">Menu dell’evento</p>
              <h3 className="mt-1 font-display text-2xl text-(--accent-primary)">{CATEGORY_LABEL[category]}</h3>
              <p className="mt-1 text-sm text-(--text-secondary)">{CATEGORY_DESCRIPTION[category]}</p>
            </div>

            <div className="px-4 py-2 sm:px-6">
              {category === "bevande" && <FreeWaterNotice />}

              {MENU_SECTIONS[category].map((section) => {
                const sectionItems = items.filter(
                  (item) => item.category === category && item.subcategory === section.key,
                );

                return (
                  <div key={section.key} className="border-b border-(--surface-border) py-4 last:border-0">
                    <h4 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-(--text-secondary)">
                      {section.label}
                    </h4>
                    {sectionItems.length === 0 ? (
                      <p className="text-sm text-(--text-secondary)">Nessuna proposta al momento.</p>
                    ) : (
                      <div className="space-y-3">
                        {sectionItems.map((item) =>
                          canEdit ? (
                            <div
                              key={item.id}
                              className="border-b border-(--surface-border) pb-3 last:border-0 last:pb-0"
                            >
                              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:flex sm:items-center">
                                <input
                                  required
                                  maxLength={200}
                                  value={item.name}
                                  onChange={(e) =>
                                    setItems((prev) =>
                                      prev.map((candidate) =>
                                        candidate.id === item.id ? { ...candidate, name: e.target.value } : candidate,
                                      ),
                                    )
                                  }
                                  className="field min-w-0 w-full sm:flex-1"
                                />
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  max="9999.99"
                                  aria-label={`Prezzo di ${item.name}`}
                                  value={Number.isNaN(item.price) ? "" : item.price}
                                  // Un campo svuotato resta vuoto (NaN) invece di diventare 0: il salvataggio lo segnala come prezzo non valido.
                                  onChange={(e) =>
                                    setItems((prev) =>
                                      prev.map((candidate) =>
                                        candidate.id === item.id
                                          ? {
                                              ...candidate,
                                              price: e.target.value === "" ? Number.NaN : Number(e.target.value),
                                            }
                                          : candidate,
                                      ),
                                    )
                                  }
                                  className="field w-full min-w-0 text-right font-mono sm:w-20"
                                />
                                <input
                                  type="number"
                                  min="0"
                                  step="1"
                                  placeholder="∞"
                                  aria-label={`Porzioni disponibili per ${item.name}`}
                                  value={item.available_portions ?? ""}
                                  onChange={(e) =>
                                    setItems((prev) =>
                                      prev.map((candidate) =>
                                        candidate.id === item.id
                                          ? {
                                              ...candidate,
                                              available_portions: e.target.value === "" ? null : Number(e.target.value),
                                            }
                                          : candidate,
                                      ),
                                    )
                                  }
                                  className="field w-full min-w-0 text-right font-mono sm:w-24"
                                />
                                <button
                                  type="button"
                                  onClick={() => draft.removeRow(item.id)}
                                  className="justify-self-start text-xs text-(--state-error) hover:underline sm:justify-self-auto"
                                >
                                  Elimina
                                </button>
                              </div>
                              <label className="mt-2 flex items-center gap-2 text-xs text-(--text-secondary)">
                                Sezione
                                <select
                                  value={`${item.category}:${item.subcategory}`}
                                  onChange={(event) => moveItem(item.id, event.target.value)}
                                  className="field min-w-0 flex-1 text-xs sm:max-w-56"
                                >
                                  {categories.map((destinationCategory) => (
                                    <optgroup key={destinationCategory} label={CATEGORY_LABEL[destinationCategory]}>
                                      {MENU_SECTIONS[destinationCategory].map((destinationSection) => (
                                        <option
                                          key={destinationSection.key}
                                          value={`${destinationCategory}:${destinationSection.key}`}
                                        >
                                          {destinationSection.label}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>
                              </label>
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
                                      onClick={() =>
                                        setItems((prev) =>
                                          prev.map((candidate) =>
                                            candidate.id === item.id
                                              ? {
                                                  ...candidate,
                                                  allergens: selected
                                                    ? candidate.allergens.filter((value) => value !== number)
                                                    : [...candidate.allergens, number].sort((a, b) => a - b),
                                                }
                                              : candidate,
                                          ),
                                        )
                                      }
                                      className={`h-7 w-7 rounded-full border text-xs ${
                                        selected
                                          ? "border-(--accent-primary) bg-(--accent-primary) text-(--text-on-accent)"
                                          : "border-(--surface-border) text-(--text-secondary)"
                                      }`}
                                    >
                                      {number}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <div key={item.id} className="flex items-start justify-between gap-3">
                              <span className="text-sm text-(--text-primary)">
                                {item.name}
                                {item.allergens.length > 0 && (
                                  <span className="ml-2 text-xs text-(--text-secondary)">
                                    Allergeni: {item.allergens.join(", ")}
                                  </span>
                                )}
                              </span>
                              <span className="shrink-0 font-mono text-sm text-(--accent-primary)">
                                {priceFormatter.format(item.price)}
                              </span>
                            </div>
                          ),
                        )}
                      </div>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => addItem(category, section.key)}
                        className="mt-3 text-xs text-(--accent-primary) hover:underline"
                      >
                        + Aggiungi in {section.label}
                      </button>
                    )}
                  </div>
                );
              })}
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
      {canEdit && draft.isDirty && (
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
