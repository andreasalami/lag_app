import { useEffect, useRef, useState } from "react";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Notice } from "../../components/ui/Notice";
import { SaveBanner } from "../../components/ui/SaveBanner";
import { useAuth } from "../auth/AuthContext";
import { canOpen, staffPage } from "../auth/staffPages";
import { supabase } from "../../lib/supabaseClient";
import { useSupabaseRows } from "../../lib/useSupabaseRows";
import { changedFields, draftUuid, isNewId, newDraftId, useDraftRows } from "../../lib/useDraftRows";
import { ALLERGENS, priceFormatter } from "../orders/orderUtils";
import { OrderEntryButton } from "../orders/OrderEntryButton";
import type { OrderMenuItem } from "../orders/types";
import { FreeWaterNotice } from "./FreeWaterNotice";
import { MENU_SECTIONS, isMenuSectionForCategory, type MenuCategory, type MenuSection } from "./menuSections";
import { appHref, pollWhileVisible } from "../../lib/browser";
import { commitmentSummary, fetchCommitments, type Commitment } from "./menuAvailability";
import { SuspendButton } from "./SuspendButton";

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
    suspended: false,
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
    suspended: false,
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
    suspended: false,
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
    suspended: false,
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

  Il menu si modifica anche a evento in corso:
  - si salvano solo i campi cambiati, così due dispositivi non si sovrascrivono;
  - le scorte si salvano per differenza (vedevo 50, scrivo 80: +30 su quelle di adesso);
  - la sospensione è un tasto a parte, applicato subito, e vale per i nuovi ordini;
  - la pagina rilegge il database ogni 20 secondi senza toccare ciò che stai modificando.
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
    fetchRows,
  } = useSupabaseRows<MenuItem>({
    table: "menu_items",
    select: "id, category, subcategory, name, price, available_portions, stock_capacity, allergens, suspended",
    orderBy: [{ column: "category" }, { column: "name" }],
    fallback: FALLBACK_ITEMS,
  });

  const draft = useDraftRows(items, setItems, loading);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Eliminazione in attesa di conferma: mostra quanti ordini già inviati contengono il prodotto.
  const [deleteTarget, setDeleteTarget] = useState<{ item: MenuItem; commitment: Commitment } | null>(null);
  const savingRef = useRef(false);
  const live = useRef({ fetchRows, syncFromServer: draft.syncFromServer });
  live.current = { fetchRows, syncFromServer: draft.syncFromServer };

  // Scorte e sospensioni cambiano mentre si vende: chi gestisce le vede aggiornate senza ricaricare.
  useEffect(() => {
    if (!canEdit) return;
    return pollWhileVisible(async () => {
      if (savingRef.current) return;
      const { data } = await live.current.fetchRows();
      if (data && !savingRef.current) live.current.syncFromServer(data);
    }, 20_000);
  }, [canEdit]);

  async function requestDelete(item: MenuItem) {
    const commitment = isNewId(item.id) ? undefined : (await fetchCommitments())?.get(item.id);
    if (commitment) setDeleteTarget({ item, commitment });
    else draft.removeRow(item.id);
  }

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
        suspended: false,
      },
    ]);
  }

  function moveItem(id: string, value: string) {
    const [category, subcategory] = value.split(":") as [Category, MenuSection];
    if (!CATEGORIES.includes(category) || !isMenuSectionForCategory(category, subcategory)) return;
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, category, subcategory } : item)));
  }

  async function handleSave() {
    setSaveError(null);
    setNotice(null);

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
      return;
    }

    const created = draft.created.map(({ id, category, subcategory, name, price, available_portions, allergens }) => ({
      id: draftUuid(id),
      category,
      subcategory,
      name,
      price,
      available_portions,
      allergens,
    }));
    // Solo i campi cambiati. Per le scorte si invia anche il numero che si vedeva: il database
    // applica la differenza a quelle di adesso, senza sovrascrivere le vendite nel frattempo.
    const updated = draft.updated.map(({ row, original }) => {
      const patch = changedFields(row, original);
      return "available_portions" in patch
        ? { ...patch, original_available_portions: original.available_portions }
        : patch;
    });

    savingRef.current = true;
    setSaving(true);
    const { data, error } = await supabase.rpc("bulk_upsert_menu_items", {
      p_created: created,
      p_updated: updated,
      p_deleted: draft.deletedIds,
    });

    if (error) {
      console.error("[Menu] Errore salvataggio:", error.message);
      setSaveError(
        error.message.includes("not_authorized") || error.code === "42501"
          ? "Non hai i permessi per modificare una di queste voci."
          : "Salvataggio non riuscito. Riprova.",
      );
      savingRef.current = false;
      setSaving(false);
      return;
    }

    const fresh = await refetch();
    draft.markSaved(fresh);
    savingRef.current = false;
    setSaving(false);
    const missing = (data as { missing?: unknown } | null)?.missing;
    if (!fresh) setNotice("Modifiche salvate, ma non riesco a rileggere il menu. Ricarica la pagina.");
    else if (Array.isArray(missing) && missing.length > 0)
      setNotice("Una voce era già stata eliminata da un altro dispositivo. Le altre modifiche sono salvate.");
  }

  return (
    <section id="menu" className="mx-auto max-w-3xl px-4 py-10">
      <h2 className="mb-1 text-2xl font-semibold">{management ? "Gestione Menu e Scorte" : "Menu"}</h2>
      <p className="mb-4 text-sm text-(--text-secondary)">
        {management
          ? "Aggiorna prodotti, prezzi, disponibilità e allergeni."
          : "Cucina e Bar disponibili durante l’evento."}
      </p>

      {!management && <OrderEntryButton />}

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
                                  onClick={() => void requestDelete(item)}
                                  className="justify-self-start text-xs text-(--state-error) hover:underline sm:justify-self-auto"
                                >
                                  Elimina
                                </button>
                              </div>
                              {/* Una voce nuova si può sospendere solo dopo il primo salvataggio. */}
                              {!isNewId(item.id) && (
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <SuspendButton
                                    item={item}
                                    onChanged={(suspended) => draft.patchSaved(item.id, { suspended })}
                                    onMissing={() =>
                                      void live.current
                                        .fetchRows()
                                        .then(({ data }) => data && draft.syncFromServer(data))
                                    }
                                  />
                                  {item.suspended && (
                                    <span className="text-xs font-semibold text-(--state-warning)">
                                      Sospeso: non ordinabile finché non lo riattivi
                                    </span>
                                  )}
                                </div>
                              )}
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
      {canEdit && notice && !draft.isDirty && (
        <div className="fixed inset-x-4 bottom-24 z-40 mx-auto max-w-3xl">
          <Notice className="surface-solid shadow-lg" onDismiss={() => setNotice(null)}>
            {notice}
          </Notice>
        </div>
      )}

      <Modal
        open={deleteTarget !== null}
        title={`Eliminare ${deleteTarget?.item.name ?? ""}?`}
        dismissible
        onClose={() => setDeleteTarget(null)}
        actions={
          <>
            <Button variant="staff-secondary" onClick={() => setDeleteTarget(null)}>
              Annulla
            </Button>
            <Button
              variant="staff-danger"
              onClick={() => {
                if (deleteTarget) draft.removeRow(deleteTarget.item.id);
                setDeleteTarget(null);
              }}
            >
              Elimina
            </Button>
          </>
        }
      >
        <p className="font-semibold text-(--text-primary)">{commitmentSummary(deleteTarget?.commitment)}</p>
        <p className="mt-2">
          Gli ordini già inviati conservano questo prodotto e vanno comunque evasi. L’eliminazione avviene quando premi
          Salva.
        </p>
      </Modal>
    </section>
  );
}
