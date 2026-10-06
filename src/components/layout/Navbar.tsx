import { useEffect, useRef, useState } from "react";
import {
  ORDER_STATUS_LABELS,
  openEventId,
  orderStatusClassName,
  pruneOrderHistory,
  readOrderHistory,
  syncOrderHistoryStatuses,
  type StoredOrder,
} from "../../features/orders/orderHistory";
import { priceFormatter } from "../../features/orders/orderUtils";
import { TICKETS_ENABLED } from "../../features/tickets/EventbriteTickets";
import { appHref } from "../../lib/browser";
import { supabase } from "../../lib/supabaseClient";

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  const [refreshingOrders, setRefreshingOrders] = useState(false);
  const staffPath = appHref("#staff");
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Esc chiude il menu e riporta il focus al pulsante che l'ha aperto.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  async function refreshOrders() {
    setOrders(readOrderHistory());
    setRefreshingOrders(true);
    // Senza rete lo storico resta com'è: meglio un ordine vecchio che un QR sparito.
    const { data, error } = await supabase.rpc("get_ordering_status");
    const stored = error ? readOrderHistory() : pruneOrderHistory(openEventId(data));
    setOrders(stored);
    if (stored.length > 0) setOrders(await syncOrderHistoryStatuses(stored));
    setRefreshingOrders(false);
  }

  function openMenu() {
    void refreshOrders();
    setMenuOpen(true);
  }

  return (
    <header className="sticky top-0 z-50 px-4 pt-4">
      <div className="glass-elevated mx-auto flex max-w-3xl items-center justify-between rounded-(--radius-pill) px-5 py-3">
        <a href="#home" className="flex items-center gap-2">
          <img src={appHref("logo-lag.png")} alt="L'Agro ai Giovani" className="h-9 w-auto" />
        </a>

        <nav className="hidden gap-6 text-sm text-(--text-secondary) sm:flex">
          {TICKETS_ENABLED && (
            <a href="#biglietti" className="hover:text-(--text-primary)">
              Biglietti
            </a>
          )}
          <a href="#programma" className="hover:text-(--text-primary)">
            Programma
          </a>
          <a href="#menu" className="hover:text-(--text-primary)">
            Menu
          </a>
          <a href="#tornei" className="hover:text-(--text-primary)">
            Torneo
          </a>
          <a href={staffPath} className="hover:text-(--text-primary)">
            Staff
          </a>
        </nav>

        <div className="relative sm:hidden">
          <button
            ref={toggleRef}
            type="button"
            onClick={openMenu}
            aria-label="Apri i miei ordini"
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation-menu"
            className="glass-elevated glass-elevated--strong flex h-10 items-center gap-2 rounded-(--radius-pill) px-4 text-sm font-semibold"
          >
            {/* Scontrino: rimanda subito agli ordini, a differenza dell'hamburger generico. */}
            <svg width="16" height="18" viewBox="0 0 16 18" fill="none" aria-hidden="true">
              <path
                d="M2 1h12v16l-2-1.5L10 17l-2-1.5L6 17l-2-1.5L2 17V1Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <line x1="5" y1="10" x2="9" y2="10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Ordini
          </button>

          {menuOpen && (
            <>
              <button
                type="button"
                aria-label="Chiudi menu"
                className="fixed inset-0 z-40 cursor-default bg-black/25"
                onClick={() => setMenuOpen(false)}
              />
              <div
                id="mobile-navigation-menu"
                className="glass-elevated glass-elevated--strong absolute right-0 top-12 z-50 w-[min(20rem,calc(100vw-2rem))] rounded-lg p-3"
              >
                <div className="rounded-md border border-(--surface-border) bg-(--surface-solid) p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">I miei ordini</p>
                    <button
                      type="button"
                      onClick={() => void refreshOrders()}
                      disabled={refreshingOrders}
                      className="text-xs text-(--text-secondary) hover:underline disabled:opacity-60"
                    >
                      {refreshingOrders ? "Aggiorno…" : "Aggiorna"}
                    </button>
                  </div>
                  {orders.length === 0 ? (
                    <p className="mt-2 text-xs leading-relaxed text-(--text-secondary)">
                      Non hai ancora ordini salvati su questo telefono.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {orders.slice(0, 3).map((order) => (
                        <li
                          key={order.order_id}
                          className="flex items-center justify-between gap-3 border-t border-(--surface-border) pt-2 text-xs first:border-0 first:pt-0"
                        >
                          <span className="min-w-0">
                            <strong className="block truncate">
                              #{order.display_number} · {order.alias}
                            </strong>
                            <span className="text-(--text-secondary)">
                              {priceFormatter.format(Number(order.total))}
                            </span>
                          </span>
                          <span className={`shrink-0 font-semibold ${orderStatusClassName(order.status)}`}>
                            {ORDER_STATUS_LABELS[order.status]}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <a
                    href={appHref("#ordina")}
                    onClick={() => setMenuOpen(false)}
                    className="mt-3 block text-center text-xs font-semibold text-(--accent-primary) hover:underline"
                  >
                    {orders.length === 0 ? "Vai alle ordinazioni" : "Apri riepilogo ordini"}
                  </a>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
