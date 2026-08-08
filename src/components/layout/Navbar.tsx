import { useState } from "react";

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const staffPath = `${import.meta.env.BASE_URL}#staff`;

  return (
    <header className="sticky top-0 z-50 px-4 pt-4">
      <div className="glass-elevated mx-auto flex max-w-3xl items-center justify-between rounded-[var(--radius-pill)] px-5 py-3">
        <a href="#home" className="flex items-center gap-2">
          <img src={`${import.meta.env.BASE_URL}logo-lag.png`} alt="L'Agro ai Giovani" className="h-9 w-auto" />
        </a>

        <nav className="hidden gap-6 text-sm text-[var(--text-secondary)] sm:flex">
          <a href="#biglietti" className="hover:text-[var(--text-primary)]">Biglietti</a>
          <a href="#menu" className="hover:text-[var(--text-primary)]">Menu</a>
          <a href="#annunci" className="hover:text-[var(--text-primary)]">Annunci</a>
          <a href="#tornei" className="hover:text-[var(--text-primary)]">Torneo</a>
          <a href={staffPath} className="hover:text-[var(--text-primary)]">Staff</a>
        </nav>

        {/* Mobile: non è un dropdown separato sotto l'hamburger — è una
            goccia di vetro che nasce ESATTAMENTE sopra al bottone (stessa
            posizione/dimensione, ancorata a destra) e si allarga verso
            sinistra fino a diventare la pillola "Staff". L'icona del
            bottone sotto sparisce in dissolvenza: la goccia lo ricopre
            per davvero, non semplicemente ci si sovrappone sopra restando
            trasparente. Chiusa, la goccia collassa esattamente sulla
            sagoma del bottone ed è invisibile/non cliccabile: il tap
            passa dritto all'hamburger sotto. */}
        <div className="relative h-10 w-10 sm:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Menu staff"
            aria-expanded={menuOpen}
            style={{ opacity: menuOpen ? 0 : 1, pointerEvents: menuOpen ? "none" : "auto" }}
            className="glass-elevated glass-elevated--strong absolute inset-0 flex h-10 w-10 items-center justify-center rounded-full transition-opacity duration-150"
          >
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
              <line x1="0" y1="1" x2="18" y2="1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <line x1="0" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <line x1="0" y1="13" x2="8" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>

          {/* Backdrop invisibile: un tap fuori dalla goccia la richiude */}
          {menuOpen && <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />}

          <div
            style={{
              width: menuOpen ? "6.5rem" : "2.5rem",
              pointerEvents: menuOpen ? "auto" : "none",
            }}
            className="glass-elevated glass-elevated--strong absolute right-0 top-0 z-50 flex h-10 items-center justify-center overflow-hidden rounded-full transition-[width] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
          >
            <a
              href={staffPath}
              style={{
                opacity: menuOpen ? 1 : 0,
                transitionDuration: menuOpen ? "150ms" : "0ms",
                transitionDelay: menuOpen ? "120ms" : "0ms",
              }}
              className="whitespace-nowrap px-5 text-sm font-semibold text-[var(--text-primary)] transition-opacity hover:text-[var(--accent-primary)]"
            >
              Staff
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}
