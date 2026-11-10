import { useCallback, useEffect, useState } from "react";
import { StaffPanel } from "../../components/ui/StaffPanel";
import { pollWhileVisible } from "../../lib/browser";
import { supabase } from "../../lib/supabaseClient";
import { fetchCommitments, type Commitment } from "../menu/menuAvailability";
import { MENU_SECTIONS, type MenuCategory } from "../menu/menuSections";
import { SuspendButton } from "../menu/SuspendButton";

type Dish = {
  id: string;
  subcategory: string;
  name: string;
  available_portions: number | null;
  suspended: boolean;
};

const AREA: Record<"cucina" | "bar", { category: MenuCategory; title: string }> = {
  cucina: { category: "cibo", title: "Pietanze" },
  bar: { category: "bevande", title: "Prodotti" },
};

/**
 * Pietanze dell'area divise per sezione: per ognuna quante porzioni restano da preparare
 * (ordini pagati) e quante sono in ordini non ancora pagati, la scorta e lo stato.
 * Da qui la cucina sospende un prodotto quando ha ancora margine per evadere gli ordini
 * già inviati, che lo ricevono comunque.
 */
export function DishesPanel({ area }: { area: "cucina" | "bar" }) {
  const { category, title } = AREA[area];
  const [dishes, setDishes] = useState<Dish[] | null>(null);
  const [commitments, setCommitments] = useState<Map<string, Commitment> | null>(null);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    const [menu, counts] = await Promise.all([
      supabase
        .from("menu_items")
        .select("id, subcategory, name, available_portions, suspended")
        .eq("category", category)
        .order("name"),
      fetchCommitments(),
    ]);
    setError(Boolean(menu.error) || counts === null);
    if (!menu.error) setDishes(menu.data as Dish[]);
    if (counts) setCommitments(counts);
  }, [category]);

  useEffect(() => {
    void refresh();
    return pollWhileVisible(() => void refresh(), 15_000);
  }, [refresh]);

  const suspendedCount = dishes?.filter((dish) => dish.suspended).length ?? 0;

  return (
    <StaffPanel
      className="mt-6"
      eyebrow="Disponibilità"
      title={title}
      description={
        dishes === null
          ? "Carico…"
          : suspendedCount === 0
            ? "Nessun prodotto sospeso."
            : `${suspendedCount} ${suspendedCount === 1 ? "prodotto sospeso" : "prodotti sospesi"}: non ordinabili finché non li riattivi.`
      }
    >
      {error && (
        <p role="status" className="mb-3 text-sm text-(--state-warning)">
          Dati non aggiornati: controllo di nuovo tra pochi secondi.
        </p>
      )}
      {MENU_SECTIONS[category].map((section) => {
        const sectionDishes = (dishes ?? []).filter((dish) => dish.subcategory === section.key);
        if (sectionDishes.length === 0) return null;
        return (
          <section key={section.key} className="border-b border-(--surface-border) py-3 last:border-0">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-(--text-secondary)">
              {section.label}
            </h3>
            <ul className="flex flex-col gap-3">
              {sectionDishes.map((dish) => {
                const commitment = commitments?.get(dish.id);
                return (
                  <li key={dish.id} className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <strong className={dish.suspended ? "text-(--state-warning)" : ""}>
                        {dish.name}
                        {dish.suspended ? " · sospeso" : ""}
                      </strong>
                      <span className="block text-xs text-(--text-secondary)">
                        Da preparare: {commitment?.paid_portions ?? 0}
                        {commitment?.unpaid_portions ? ` · in ordini non pagati: ${commitment.unpaid_portions}` : ""}
                        {dish.available_portions !== null ? ` · scorta: ${dish.available_portions}` : ""}
                      </span>
                    </div>
                    <SuspendButton
                      item={dish}
                      onChanged={(suspended) =>
                        setDishes(
                          (current) =>
                            current?.map((item) => (item.id === dish.id ? { ...item, suspended } : item)) ?? null,
                        )
                      }
                      onMissing={() => void refresh()}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {dishes?.length === 0 && <p className="text-sm text-(--text-secondary)">Nessun prodotto in menu.</p>}
    </StaffPanel>
  );
}
