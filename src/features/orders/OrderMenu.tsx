import { FreeWaterNotice } from "../menu/FreeWaterNotice";
import { MENU_SECTIONS } from "../menu/menuSections";
import { remainingStock, type Cart } from "./cart";
import { priceFormatter } from "./orderUtils";
import type { OrderMenuItem, OrderingCatalog } from "./types";

/** Prodotti ordinabili per sezione, con lo stato delle scorte; un tocco aggiunge al carrello. */
export function OrderMenu({
  catalog,
  cart,
  onAdd,
}: {
  catalog: OrderingCatalog;
  cart: Cart;
  onAdd: (item: OrderMenuItem) => void;
}) {
  return (["cibo", "bevande"] as const).map((category) => (
    <section key={category} className="mt-8">
      <h2 className="text-2xl">{category === "cibo" ? "Cucina" : "Bar"}</h2>
      {category === "bevande" && <FreeWaterNotice />}
      {MENU_SECTIONS[category].map((section) => {
        const sectionItems = catalog.items.filter(
          (item) => item.category === category && item.subcategory === section.key,
        );
        if (sectionItems.length === 0) return null;
        return (
          <div key={section.key} className="mt-5">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.12em] text-[var(--accent-primary)]">
              {section.label}
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {sectionItems.map((item) => {
                const almostFinished =
                  item.available_portions !== null &&
                  item.stock_capacity !== null &&
                  item.available_portions > 0 &&
                  item.available_portions <= Math.ceil(item.stock_capacity * 0.2);
                const finished = item.available_portions === 0;
                // Le scorte compaiono solo qui: il menu pubblico resta fisso per la serata.
                const allInCart = !finished && remainingStock(cart, item) === 0;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onAdd(item)}
                    disabled={finished || allInCart}
                    className="surface-solid flex min-h-20 items-start justify-between gap-3 rounded-[var(--radius-md)] p-3 text-left transition-colors hover:bg-[var(--surface-solid-hover)] disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <span>
                      <span className="block text-sm font-semibold">{item.name}</span>
                      {item.allergens.length > 0 && (
                        <span className="mt-1 block text-xs text-[var(--text-secondary)]">
                          Allergeni: {item.allergens.join(", ")}
                        </span>
                      )}
                      {almostFinished && (
                        <span className="mt-1 block text-xs text-[var(--state-warning)]">Quasi terminato</span>
                      )}
                      {finished && <span className="mt-1 block text-xs text-[var(--state-error)]">Terminato</span>}
                      {allInCart && (
                        <span className="mt-1 block text-xs text-[var(--state-warning)]">
                          Hai nel carrello tutte le porzioni rimaste
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-sm text-[var(--accent-primary)]">
                      {priceFormatter.format(Number(item.price))}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  ));
}
