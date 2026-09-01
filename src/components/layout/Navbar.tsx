import { useState } from "react";
import { readOrderHistory, type PublicOrderStatus, type StoredOrder } from "../../features/orders/orderHistory";
import { priceFormatter } from "../../features/orders/orderUtils";

const ORDER_STATUS_LABELS: Record<PublicOrderStatus, string> = {
  in_attesa_pagamento: "Da pagare",
  pagato: "In preparazione",
  consegnato: "Ritirato",
  annullato: "Annullato",
};

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  const staffPath = `${import.meta.env.BASE_URL}#staff`;

  function openMenu() {
    setOrders(readOrderHistory());
    setMenuOpen(true);
  }

  return (
    <header className="sticky top-0 z-50 px-4 pt-4">
      <div className="glass-elevated mx-auto flex max-w-3xl items-center justify-between rounded-[var(--radius-pill)] px-5 py-3">
        <a href="#home" className="flex items-center gap-2">
          <img src={`${import.meta.env.BASE_URL}logo-lag.png`} alt="L'Agro ai Giovani" className="h-9 w-auto" />
        </a>

        <nav className="hidden gap-6 text-sm text-[var(--text-secondary)] sm:flex">
          <a href="#biglietti" className="hover:text-[var(--text-primary)]">Biglietti</a>
          <a href="#programma" className="hover:text-[var(--text-primary)]">Programma</a>
          <a href="#menu" className="hover:text-[var(--text-primary)]">Menu</a>
          <a href="#tornei" className="hover:text-[var(--text-primary)]">Torneo</a>
          <a href={staffPath} className="hover:text-[var(--text-primary)]">Staff</a>
        </nav>

        <div className="relative h-10 w-10 sm:hidden">
          <button
            type="button"
            onClick={openMenu}
            aria-label="Apri menu"
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation-menu"
            className="glass-elevated glass-elevated--strong absolute inset-0 flex h-10 w-10 items-center justify-center rounded-full"
          >
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
              <line x1="0" y1="1" x2="18" y2="1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <line x1="0" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <line x1="0" y1="13" x2="8" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
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
                className="glass-elevated glass-elevated--strong absolute right-0 top-12 z-50 w-[min(20rem,calc(100vw-2rem))] rounded-[var(--radius-lg)] p-3"
              >
                <a
                  href="#programma"
                  onClick={() => setMenuOpen(false)}
                  className="surface-solid flex min-h-12 items-center justify-between rounded-[var(--radius-md)] px-4 text-sm font-semibold"
                >
                  Programma della serata
                  <span aria-hidden className="text-[var(--accent-primary)]">↓</span>
                </a>

                <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--surface-solid)] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">I miei ordini</p>
                    <span className="text-xs text-[var(--text-secondary)]">{orders.length}</span>
                  </div>
                  {orders.length === 0 ? (
                    <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">Non hai ancora ordini salvati su questo telefono.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {orders.slice(0, 3).map((order) => (
                        <li key={order.order_id} className="flex items-center justify-between gap-3 border-t border-[var(--surface-border)] pt-2 text-xs first:border-0 first:pt-0">
                          <span className="min-w-0">
                            <strong className="block truncate">#{order.display_number} · {order.alias}</strong>
                            <span className="text-[var(--text-secondary)]">{priceFormatter.format(Number(order.total))}</span>
                          </span>
                          <span className="shrink-0 text-[var(--accent-primary)]">{ORDER_STATUS_LABELS[order.status]}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <a
                    href={`${import.meta.env.BASE_URL}#ordina`}
                    onClick={() => setMenuOpen(false)}
                    className="mt-3 block text-center text-xs font-semibold text-[var(--accent-primary)] hover:underline"
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
